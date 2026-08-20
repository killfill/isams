import { start } from './mockserver.js';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const tok = (over: Record<string, unknown> = {}) => [
  b64({ alg: 'RS256', typ: 'at+jwt' }),
  b64({ iss: 'https://britishroyal.isams.cloud/auth', iat: now, exp: now + 3600,
        aud: ['REST API', 'Authentication Server'],
        scope: ['openid', 'iSAMS.CloudPortals.Api', 'offline_access'], ...over }),
  'firmafalsa'].join('.');

const stop = await start(8731);
// El CLI arma https://{tenant}.isams.cloud; se redirige al mock por resolución local
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function run(args: string[], env: Record<string, string> = {}) {
  // spawnSync y no execFileSync: este devuelve solo stdout, así que en una
  // corrida exitosa el stderr se perdía y nada podía verificar lo que el CLI
  // avisa cuando NO falla.
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', ...args],
    { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// ❗ Toda corrida de acá abajo pasa --token o --token-file explícito. Sin
// ninguno de los dos, el CLI cae en credenciales.json del directorio actual
// —que en el repo es el archivo REAL del usuario— y una prueba terminaría
// gastándole la cadena de refresh contra el servidor de verdad.
const SIN_CREDENCIALES = join(mkdtempSync(join(tmpdir(), 'e2e-')), 'no', 'existe.json');

let pass = 0, failn = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { failn++; console.log(`  FAIL ${name} ${detail}`); }
};

console.log('\n1. Validación de parámetros');
const sinCreds = run(['--format', 'html', '--token-file', SIN_CREDENCIALES]);
check('sin credenciales falla con código 3', sinCreds.code === 3, sinCreds.err.trim());
check('  y nombra la ruta absoluta que miró', sinCreds.err.includes(SIN_CREDENCIALES));
check('  sin haber creado nada', !existsSync(SIN_CREDENCIALES));
check('sin --format falla con código 2', run(['--token', tok()]).code === 2);
check('formato inválido falla', run(['--token', tok(), '--format', 'pdf']).code === 2);
check('flag desconocida falla', run(['--token', tok(), '--format', 'html', '--bogus']).code === 2);
check('dos salidas fallan', run(['--token', tok(), '--format', 'html', 'a.html', 'b.html']).code === 2);

console.log('\n2. Validación del token');
const expired = run(['--token', tok({ exp: now - 600 }), '--format', 'html']);
check('token vencido -> código 3', expired.code === 3, expired.err.trim());
check('  mensaje dice hace cuánto', /expiró hace 10 min/.test(expired.err));
const noAud = run(['--token', tok({ aud: ['Authentication Server'] }), '--format', 'html']);
check('sin audiencia REST API -> código 3', noAud.code === 3);
const badIss = run(['--token', tok({ iss: 'https://example.com/auth' }), '--format', 'html']);
check('emisor ajeno -> código 3', badIss.code === 3);
check('token malformado -> código 3', run(['--token', 'no-es-jwt', '--format', 'html']).code === 3);

console.log('\n3. Huella del contenido en la salida del CLI');
// --from-raw no necesita credenciales ni red: renderiza de un archivo guardado.
const rawDir = mkdtempSync(join(tmpdir(), 'e2e-raw-'));
const rawA = join(rawDir, 'a.json');
const rawB = join(rawDir, 'b.json');
const fixture = JSON.parse(readFileSync('test/fixture.raw.json', 'utf8'));
writeFileSync(rawA, JSON.stringify({ ...fixture, extractedAt: '2026-08-20T01:26:41.000Z' }));
writeFileSync(rawB, JSON.stringify({ ...fixture, extractedAt: '2026-08-21T17:03:12.000Z' }));

const salidaA = join(rawDir, 'a.html');
const salidaB = join(rawDir, 'b.html');
const corridaA = run(['--format', 'html', '--from-raw', rawA, '--output', salidaA]);
const corridaB = run(['--format', 'html', '--from-raw', rawB, '--output', salidaB]);
const huella = (r: { err: string }) => r.err.match(/^stable-md5: ([0-9a-f]{32})$/m)?.[1];

check('el CLI imprime stable-md5', !!huella(corridaA), corridaA.err.trim());
check('  va a stderr, no a stdout', !corridaA.out.includes('stable-md5'));
check('  dos extracciones distintas, misma huella',
  !!huella(corridaA) && huella(corridaA) === huella(corridaB));
check('  y sin embargo los archivos difieren',
  readFileSync(salidaA, 'utf8') !== readFileSync(salidaB, 'utf8'));
check('  el archivo lleva la fecha real, no la normalizada',
  readFileSync(salidaA, 'utf8').includes('2026') && !readFileSync(salidaA, 'utf8').includes('1970'));

// Quien automatiza usa --quiet, y es justamente quien necesita la huella.
const callada = run(['--format', 'html', '--from-raw', rawA, '--output', salidaA, '--quiet']);
check('--quiet no silencia la huella',
  !!huella(callada) && huella(callada) === huella(corridaA), callada.err.trim());
check('  pero sí el resto del progreso', !/Leído|Escrito/.test(callada.err));

const enMd = run(['--format', 'md', '--from-raw', rawA, '--output', join(rawDir, 'a.md')]);
check('cada formato tiene su huella', !!huella(enMd) && huella(enMd) !== huella(corridaA));

// Sin --output el informe va a stdout: la huella no puede contaminarlo.
const aStdout = run(['--format', 'csv', '--from-raw', rawA, '--quiet']);
check('con salida a stdout la huella sigue en stderr',
  !!huella(aStdout) && !aStdout.out.includes('stable-md5') && aStdout.out.includes(','));

console.log('\n4. Niveles de detalle');
const porDefecto = run(['--format', 'html', '--from-raw', rawA, '--output', salidaA]);
const conDetalle = run(['--format', 'html', '--from-raw', rawA, '--output', salidaA, '--verbose']);

check('por defecto dice qué escribió', /Escrito .*\(\d+ bytes\)/.test(porDefecto.err), porDefecto.err.trim());
check('  sin el control de calidad cuando no hay nada que decir',
  !/reproducidos, .* desajustes/.test(porDefecto.err));
check('  sin los avisos de severidad warn', !porDefecto.err.includes('[warn]'));

check('--verbose trae el control de calidad completo', /reproducidos, .* desajustes/.test(conDetalle.err));
check('  y los avisos warn', conDetalle.err.includes('[warn]'));

const callado = run(['--format', 'html', '--from-raw', rawA, '--output', salidaA, '--quiet']);
check('--quiet deja solo la huella', callado.err.trim().split('\n').length === 1);
check('--quiet y --verbose juntos son error de argumentos',
  run(['--format', 'html', '--from-raw', rawA, '--output', salidaA, '--quiet', '--verbose']).code === 2);

// ❗ Lo que dice que el informe no se puede creer no depende del nivel de
// detalle: el HTML no lleva control de calidad adentro, así que si esto se
// esconde por defecto, un promedio sin respaldo se publica en silencio.
const fixtureRoto = JSON.parse(readFileSync('test/fixture.raw.json', 'utf8'));
for (const mb of fixtureRoto.students[0].markbooks) {
  const c = mb.columns.find((x: any) => x.type === 'Calculation' && x.name === 'Promedio Semestral 1' && x.value !== null);
  if (c) { c.value = '2.0'; break; }
}
const rawRoto = join(rawDir, 'roto.json');
writeFileSync(rawRoto, JSON.stringify(fixtureRoto));
const conDesajuste = run(['--format', 'html', '--from-raw', rawRoto, '--output', join(rawDir, 'roto.html')]);
check('un desajuste se avisa aunque no haya --verbose', /sin respaldo/.test(conDesajuste.err), conDesajuste.err.trim());
check('  con el aviso de severidad error', conDesajuste.err.includes('[error] MODEL_MISMATCH'));
check('  y cambia la huella', huella(conDesajuste) !== huella(porDefecto));
check('--strict sigue saliendo con código 1 aunque haya --quiet',
  run(['--format', 'html', '--from-raw', rawRoto, '--output', join(rawDir, 'roto.html'), '--quiet', '--strict']).code === 1);

stop();
console.log(`\n${pass} ok, ${failn} fallidas`);
process.exit(failn ? 1 : 0);
