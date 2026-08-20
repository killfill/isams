/**
 * Los subcomandos `auth` de punta a punta, con el CLI como proceso aparte:
 * códigos de salida (W4), `auth refresh` (W5), `auth status` (W9) y el margen
 * de renovación (W3).
 *
 * Se levanta el CLI de verdad porque lo que se está probando es el contrato con
 * quien lo llama —el asistente que lee el código de salida y decide si escribe a
 * la KB o aborta—, y ese contrato vive en el proceso, no en una función.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { makeToken } from './maketoken.js';
import { BOOTSTRAP_SNIPPET } from '../src/bootstrap.js';

let ok = 0, bad = 0;
const t = (n: string, c: boolean, d = '') => { c ? ok++ : bad++; console.log(`  ${c ? 'ok  ' : 'FALLA'} ${n}${c ? '' : ' ' + d}`); };

console.log('\n10. Subcomandos auth');

let respond: (res: ServerResponse) => void = (r) => r.end('{}');
let golpes = 0;
const srv = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => { golpes++; respond(res); });
});
await new Promise<void>((r) => srv.listen(0, r));
const origin = `http://127.0.0.1:${(srv.address() as any).port}`;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const PRELOAD = pathToFileURL('test/fetchredirect.mjs').href;
const TSX = join('node_modules', '.bin', 'tsx');

/**
 * Asíncrono a propósito: el servidor de identidad de mentira vive en ESTE
 * proceso, así que bloquear el event loop —con spawnSync— lo deja sordo y el
 * hijo se cuelga esperando una respuesta que nadie va a escribir.
 */
function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(TSX, ['src/cli.ts', ...args], {
      env: { ...process.env, NODE_OPTIONS: `--import ${PRELOAD}`, ISAMS_TEST_ORIGIN: origin },
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const dir = mkdtempSync(join(tmpdir(), 'authcmd-'));
const cred = join(dir, 'credenciales.json');
const diario = join(dir, 'credenciales.journal.jsonl');
const seed = (c: Record<string, unknown>) => writeFileSync(cred, JSON.stringify(c, null, 2), { mode: 0o600 });
const leer = () => JSON.parse(readFileSync(cred, 'utf8'));
const bytes = () => readFileSync(cred, 'utf8');
const nuevoAT = (min: number) => makeToken({ tenant: 'britishroyal', expiresInSec: min * 60 });

// ── credenciales ausentes: exit 3, sin red, nombrando la ruta resuelta ───────
const faltante = join(dir, 'no', 'existe', 'credenciales.json');
golpes = 0;
let r = await run(['auth', 'refresh', '--token-file', faltante]);
t('archivo ausente → código 3', r.code === 3, `code=${r.code}`);
t('  sin tocar la red', golpes === 0);
t('  nombra la ruta absoluta que miró', r.err.includes(faltante));
t('  dice que no existe', r.err.includes('(no existe)'));
t('  ofrece el remedio local', r.err.includes('pbpaste'));
t('  y el de la tarea programada', r.err.includes('claude/credenciales.json'));
t('  no crea el archivo al fallar', !existsSync(faltante));
// El momento en que hacen falta las instrucciones es este. Mandar a correr otro
// comando para leerlas agrega un paso, y con un modelo de por medio invita a
// reconstruir el snippet de memoria —que es justo lo que no puede pasar.
t('  trae el snippet entero, no un puntero a otro comando',
  r.err.includes('sessionStorage.removeItem') && r.err.includes('location.replace("about:blank")'));
t('  con la ruta pedida ya sustituida en el pbpaste', r.err.includes(`pbpaste > ${faltante}`));

// ── auth refresh · ok ────────────────────────────────────────────────────────
seed({ accessToken: nuevoAT(-10), refreshToken: 'RT-VIEJO-8f2a1c', tenant: 'britishroyal' });
respond = (res) => json(res, 200, { access_token: nuevoAT(60), refresh_token: 'RT-NUEVO-b71e04', expires_in: 3600 });
r = await run(['auth', 'refresh', '--token-file', cred, '--trigger', 'scheduled']);
t('renovación exitosa → código 0', r.code === 0, r.err.trim());
t('  imprime rotated: yes', /^rotated: yes /.test(r.out));
t('  con la cola del refresh nuevo', r.out.includes('rtTail: b71e04'));
t('  y un expiresAt ISO sin milisegundos', /expiresAt: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/.test(r.out));
t('  la línea va a stdout, no a stderr', r.out.includes('rotated:') && !r.err.includes('rotated:'));
t('  persiste el refresh rotado', leer().refreshToken === 'RT-NUEVO-b71e04');
t('  guarda la cola del anterior', leer().refreshTokenPrevious === '8f2a1c');
t('  la cola anterior es solo cola', leer().refreshTokenPrevious.length === 6);
t('  el archivo conserva permisos 600', (statSync(cred).mode & 0o777) === 0o600);
t('  no deja el token entero anterior', !bytes().includes('RT-VIEJO-8f2a1c'));

// ── la bitácora, hermana del archivo de credenciales ─────────────────────────
t('crea la bitácora al lado de las credenciales', existsSync(diario));
const lineas = () => readFileSync(diario, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let ls = lineas();
t('  anota el bootstrap de una cola nunca vista', ls[0].event === 'bootstrap');
t('  y la renovación', ls.some((e) => e.event === 'refresh' && e.outcome === 'ok'));
t('  con el trigger que se pasó', ls.every((e) => e.trigger === 'scheduled'));
t('  las líneas de una corrida comparten runId', new Set(ls.map((e) => e.runId)).size === 1);
t('  la bitácora no trae ningún token entero',
  !readFileSync(diario, 'utf8').includes('RT-NUEVO-b71e04') && !readFileSync(diario, 'utf8').includes('RT-VIEJO-8f2a1c'));
t('  la bitácora nace con permisos 600', (statSync(diario).mode & 0o777) === 0o600);

// ── auth refresh · dentro del margen no consume nada ─────────────────────────
const antes = bytes();
golpes = 0;
r = await run(['auth', 'refresh', '--token-file', cred]);
t('segunda llamada seguida → rotated: no', /^rotated: no /.test(r.out), r.out.trim());
t('  código 0', r.code === 0);
t('  no llamó al servidor de identidad', golpes === 0);
t('  dejó el archivo byte a byte igual', bytes() === antes);
t('  la cola informada es la vigente', r.out.includes('rtTail: b71e04'));

// ── W3 · margen de 900 s ─────────────────────────────────────────────────────
seed({ accessToken: nuevoAT(20), refreshToken: 'RT-20MIN', tenant: 'britishroyal' });
golpes = 0;
r = await run(['auth', 'refresh', '--token-file', cred]);
t('con 20 min por delante NO renueva', golpes === 0 && /rotated: no /.test(r.out));

seed({ accessToken: nuevoAT(12), refreshToken: 'RT-12MIN', tenant: 'britishroyal' });
respond = (res) => json(res, 200, { access_token: nuevoAT(60), refresh_token: 'RT-TRAS-12', expires_in: 3600 });
golpes = 0;
r = await run(['auth', 'refresh', '--token-file', cred]);
t('con 12 min por delante SÍ renueva', golpes === 1 && /rotated: yes /.test(r.out), r.out.trim());

// ── auth refresh · dead ──────────────────────────────────────────────────────
seed({ accessToken: nuevoAT(-10), refreshToken: 'RT-MUERTO', tenant: 'britishroyal' });
const antesMuerto = bytes();
respond = (res) => json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token has expired' });
r = await run(['auth', 'refresh', '--token-file', cred]);
t('invalid_grant → código 3', r.code === 3, `code=${r.code}`);
t('  muestra el error_description del servidor', r.err.includes('Refresh token has expired'));
t('  dice que no sirve reintentar', /no sirve reintentar/.test(r.err));
t('  apunta a la bitácora', r.err.includes(diario));
t('  deja el archivo byte a byte igual', bytes() === antesMuerto);
t('  NO marca suspect', leer().suspect === undefined);
t('  trae el bootstrap entero: es el remedio de este caso',
  r.err.includes('sessionStorage.removeItem') && r.err.includes(`pbpaste > ${cred}`));
t('  lo anota como dead', lineas().some((e) => e.outcome === 'dead' && e.httpStatus === 400));
t('  con el error_description en la bitácora',
  lineas().some((e) => e.errorDescription === 'Refresh token has expired'));

// ── auth refresh · indeterminate ─────────────────────────────────────────────
seed({ accessToken: nuevoAT(-10), refreshToken: 'RT-DUDOSO', tenant: 'britishroyal' });
respond = (res) => json(res, 500, { error: 'server_error' });
r = await run(['auth', 'refresh', '--token-file', cred]);
t('5xx → código 5', r.code === 5, `code=${r.code}`);
t('  marca suspect en el archivo', leer().suspect === true);
t('  conserva el refresh token, que puede seguir vivo', leer().refreshToken === 'RT-DUDOSO');
t('  no afirma que la cadena murió', !/bootstrap nuevo desde el navegador/.test(r.err));
t('  lo anota como indeterminate', lineas().some((e) => e.outcome === 'indeterminate'));
// Mandar a rehacer el bootstrap una cadena que quizá sigue viva es destruirla.
t('  NO ofrece el bootstrap: la cadena puede seguir viva',
  !r.err.includes('sessionStorage.removeItem'));

// La corrida siguiente tiene que decirlo antes que nada.
respond = (res) => json(res, 500, { error: 'server_error' });
r = await run(['auth', 'refresh', '--token-file', cred]);
t('la corrida siguiente avisa del estado sospechoso',
  r.err.includes('no pudo confirmar si la renovación se completó'));
t('  y el aviso va primero', r.err.trimStart().startsWith('aviso: La corrida anterior'));

// Un ok limpia la marca.
respond = (res) => json(res, 200, { access_token: nuevoAT(60), refresh_token: 'RT-SANO', expires_in: 3600 });
r = await run(['auth', 'refresh', '--token-file', cred]);
t('un ok posterior limpia suspect', r.code === 0 && leer().suspect === undefined);

// ── auth status · no consume, no rota, no escribe ────────────────────────────
seed({ accessToken: nuevoAT(34), refreshToken: 'RT-STATUS-8f2a1c', tenant: 'britishroyal', suspect: true });
const antesStatus = bytes();
golpes = 0;
const s1 = await run(['auth', 'status', '--token-file', cred]);
const s2 = await run(['auth', 'status', '--token-file', cred]);
t('auth status → código 0', s1.code === 0, s1.err.trim());
t('  no toca la red', golpes === 0);
t('  deja el archivo byte a byte igual', bytes() === antesStatus);
t('  dos corridas dan la misma salida', s1.out === s2.out);
t('  muestra el tenant', /tenant\s+britishroyal/.test(s1.out));
t('  muestra cuánto le queda al token', /access token\s+vence en 3[34] min/.test(s1.out), s1.out);
t('  muestra solo la cola del refresh', s1.out.includes('…8f2a1c') && !s1.out.includes('RT-STATUS-8f2a1c'));
t('  marca el estado sospechoso', /estado\s+SOSPECHOSO/.test(s1.out));
t('  y explica qué significa', s1.out.includes('puede estar vivo o muerto'));
t('  resume las renovaciones', /renovaciones\s+\d+ ok · \d+ muertas · \d+ indetermina/.test(s1.out));
t('  informa la última renovación', /última renovación\s+\d{4}-/.test(s1.out));

seed({ accessToken: nuevoAT(-90), refreshToken: 'RT-VENCIDO', tenant: 'britishroyal' });
const s3 = await run(['auth', 'status', '--token-file', cred]);
t('describe un token ya vencido sin reventar', s3.code === 0 && /venció hace 90 min/.test(s3.out), s3.out);
t('  y el estado vuelve a ok', /estado\s+ok/.test(s3.out));

// ── la bitácora puede vivir en otro lado, y se crea el camino ────────────────
seed({ accessToken: nuevoAT(40), refreshToken: 'RT-J', tenant: 'britishroyal' });
const otroDiario = join(dir, 'a', 'b', 'c', 'diario.jsonl');
r = await run(['auth', 'refresh', '--token-file', cred, '--journal', otroDiario]);
t('--journal crea los directorios que falten', existsSync(otroDiario), r.err.trim());

// ── validación de argumentos ─────────────────────────────────────────────────
t('subcomando auth desconocido → código 2', (await run(['auth', 'bogus'])).code === 2);
t('--trigger inválido → código 2', (await run(['auth', 'status', '--token-file', cred, '--trigger', 'x'])).code === 2);
t('--format no aplica a auth → código 2', (await run(['auth', 'status', '--token-file', cred, '--format', 'html'])).code === 2);
t('--token-endpoint ya no existe → código 2',
  (await run(['auth', 'status', '--token-endpoint', 'https://x/y'])).code === 2);
t('--token-api-key ya no existe → código 2',
  (await run(['auth', 'status', '--token-api-key', 'k'])).code === 2);
const help = await run(['--help']);
t('--help no menciona el endpoint borrado',
  !help.out.includes('--token-endpoint') && !help.out.includes('--token-api-key') && !help.out.includes('--token-header'));
t('--help documenta los flags nuevos',
  help.out.includes('--journal') && help.out.includes('--trigger') && help.out.includes('auth refresh'));
t('--help documenta los códigos de salida', help.out.includes('5 estado de la cadena'));

// ── auth bootstrap · las instrucciones, sin necesitar credenciales ───────────
golpes = 0;
const bs = await run(['auth', 'bootstrap', '--token-file', faltante]);
t('auth bootstrap → código 0 aunque no haya credenciales', bs.code === 0, bs.err.trim());
t('  no toca la red', golpes === 0);
t('  no crea ningún archivo', !existsSync(faltante));
t('  trae el snippet', bs.out.includes('Object.keys(sessionStorage)'));
t('  incluido el borrado de la clave OIDC', bs.out.includes('sessionStorage.removeItem(k)'));
t('  y el blanqueo de la pestaña', bs.out.includes('location.replace("about:blank")'));
t('  con la ruta pedida en el pbpaste', bs.out.includes(`pbpaste > ${faltante}`));
t('  ofrece también el destino de tarea programada', bs.out.includes('claude/credenciales.json'));
t('  advierte de no hacer logout', bs.out.includes('No hagas logout'));
t('  explica por qué la pestaña queda en blanco', bs.out.includes('compite por la'));
t('  dice que no pase por el chat', /NO lo pegues en un chat|NO lo pegues en el chat/.test(bs.out));
t('  va a stdout', bs.out.length > 500 && bs.err.trim() === '');
t('  sin --token-file usa el archivo por defecto',
  (await run(['auth', 'bootstrap'])).out.includes('credenciales.json'));

// El snippet está en dos lados: el CLI y el README, que se lee sin poder correr
// nada. Que se separen no falla ruidosamente —deja una copia vieja que apaga a
// medias el renovador del portal—, así que lo verifica una prueba.
const readme = readFileSync('README.md', 'utf8');
const enReadme = readme.match(/```js\n(;\(\(\) => \{[\s\S]*?)\n```/)?.[1] ?? '';
t('el README trae el snippet', enReadme.includes('sessionStorage.removeItem'));
t('y es idéntico al que emite el CLI', enReadme.trim() === BOOTSTRAP_SNIPPET.trim(),
  '\n--- README:\n' + enReadme + '\n--- CLI:\n' + BOOTSTRAP_SNIPPET);

srv.close();
console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
