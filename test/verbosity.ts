/**
 * Los niveles de detalle sobre una extracción de verdad.
 *
 * Van aparte de e2e.ts porque ahí todo corre con --from-raw, que se salta la
 * extracción entera: sin ella no hay titulares por alumno, ni línea de tenant,
 * ni conteo de libros, así que las pruebas de esas líneas pasarían sin probar
 * nada. Acá el CLI sale a buscar los datos al mock.
 */
import { start } from './mockserver.js';
import { makeToken } from './maketoken.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let ok = 0, bad = 0;
const t = (n: string, c: boolean, d = '') => { c ? ok++ : bad++; console.log(`  ${c ? 'ok  ' : 'FALLA'} ${n}${c ? '' : ' ' + d}`); };

console.log('\n11. Niveles de detalle en una extracción real');

const PORT = 8799;
const stop = await start(PORT);
const dir = mkdtempSync(join(tmpdir(), 'verbosity-'));
const cred = join(dir, 'cred.json');
writeFileSync(cred, JSON.stringify({
  accessToken: makeToken({ tenant: 'britishroyal', expiresInSec: 3540 }),
  refreshToken: 'RT', tenant: 'britishroyal',
}));

const PRELOAD = pathToFileURL('test/fetchredirect.mjs').href;
/** Asíncrono: el mock vive en este proceso y spawnSync lo dejaría sordo. */
function run(extra: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(join('node_modules', '.bin', 'tsx'), [
      'src/cli.ts', '--format', 'html', '--output', join(dir, 'out.html'), '--token-file', cred, ...extra,
    ], { env: { ...process.env, NODE_OPTIONS: `--import ${PRELOAD}`, ISAMS_TEST_ORIGIN: `http://127.0.0.1:${PORT}` } });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const normal = await run([]);
t('la corrida termina bien', normal.code === 0, normal.err.trim());
t('dice por quién va, por su nombre de pila', /Extrayendo datos de Alexander…/.test(normal.err), normal.err.trim());
t('  para cada alumno', (normal.err.match(/Extrayendo datos de /g) ?? []).length === 2);
t('  con el nombre de pila y no el completo', !normal.err.includes('Alexander Leon Neumann Lopez'));
t('y qué archivo escribió', /Escrito .*\(\d+ bytes\)/.test(normal.err));
t('y la huella', /^stable-md5: [0-9a-f]{32}$/m.test(normal.err));
t('sin la línea de tenant', !normal.err.includes('Tenant britishroyal'));
t('sin "Listando estudiantes"', !normal.err.includes('Listando estudiantes'));
t('sin el conteo de libros y columnas', !/libros, \d+ columnas/.test(normal.err));
t('sin los avisos warn', !normal.err.includes('[warn]'));
t('en total, cuatro líneas', normal.err.trim().split('\n').length === 4, normal.err.trim());

const detallado = await run(['--verbose']);
t('--verbose trae el tenant', detallado.err.includes('Tenant britishroyal'), detallado.err.trim());
t('  el listado de estudiantes', detallado.err.includes('Listando estudiantes'));
t('  el conteo por alumno', /libros, \d+ columnas/.test(detallado.err));
t('  el control de calidad', /reproducidos, .* desajustes/.test(detallado.err));
t('  los avisos warn', detallado.err.includes('[warn]'));
t('  y sigue trayendo los titulares', /Extrayendo datos de Alexander…/.test(detallado.err));
t('  el nombre completo solo aparece en el detalle', detallado.err.includes('Alexander Leon Neumann Lopez'));

const callado = await run(['--quiet']);
t('--quiet deja solo la huella', callado.err.trim().split('\n').length === 1 && callado.err.includes('stable-md5'), callado.err.trim());
t('  y la extracción igual ocurrió', callado.code === 0);

stop();
console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
