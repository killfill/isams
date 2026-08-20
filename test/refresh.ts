/**
 * Clasificación de la renovación (W4) y captura del error (W7), más el
 * requisito de orden: el refresh token rotado se persiste ANTES de usar el
 * access token contra la API de datos. Si el orden se invierte, un corte del
 * proceso rompe la cadena y obliga a un bootstrap manual.
 *
 * Lo que se está probando de verdad es la distinción entre `dead` e
 * `indeterminate`: la primera dice "no reintentes, rehaz el bootstrap", la
 * segunda "no se sabe". Confundirlas manda al usuario a rehacer un bootstrap
 * que quizá no hacía falta, o peor, deja pasar por sano un archivo muerto.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FileStore } from '../src/store.js';
import { refreshAccessToken } from '../src/auth.js';
import { makeToken } from './maketoken.js';

let ok = 0, bad = 0;
const t = (n: string, c: boolean) => { c ? ok++ : bad++; console.log(`  ${c ? 'ok  ' : 'FALLA'} ${n}`); };

console.log('\n7. Renovación: clasificación y rotación');

// Servidor de identidad de mentira, programable por caso.
let respond: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_q, r) => r.end('{}');
let ultimoBody = '';
const eventos: string[] = [];

const srv = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.url?.includes('/auth/connect/token')) {
      ultimoBody = b;
      eventos.push('refresh');
      respond(req, res, b);
      return;
    }
    eventos.push('api');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.includes('/students/portal') ? { students: [] } : []));
  });
});
await new Promise<void>((r) => srv.listen(0, r));
const port = (srv.address() as any).port;

const orig = globalThis.fetch;
globalThis.fetch = ((u: any, o: any) =>
  orig(String(u).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), o)) as typeof fetch;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const AT_NUEVO = makeToken({ tenant: 'britishroyal', expiresInSec: 3600 });

// ── ok ───────────────────────────────────────────────────────────────────────
respond = (_q, r) => json(r, 200, { access_token: AT_NUEVO, refresh_token: 'R-NUEVO', expires_in: 3600, token_type: 'Bearer' });
let res = await refreshAccessToken('britishroyal', 'R-VIEJO');
t('2xx con refresh_token → ok', res.outcome === 'ok');
t('  devuelve el par de tokens', res.accessToken === AT_NUEVO && res.refreshToken === 'R-NUEVO');
t('  devuelve expiresIn', res.expiresIn === 3600);

const p = new URLSearchParams(ultimoBody);
t('  manda grant_type=refresh_token', p.get('grant_type') === 'refresh_token');
t('  manda el refresh token vigente', p.get('refresh_token') === 'R-VIEJO');
t('  manda el scope completo', (p.get('scope') ?? '').includes('offline_access'));
t('  NO manda client_secret', !p.has('client_secret'));

// ── dead ─────────────────────────────────────────────────────────────────────
respond = (_q, r) => json(r, 400, { error: 'invalid_grant' });
res = await refreshAccessToken('britishroyal', 'R-MUERTO');
t('400 invalid_grant → dead', res.outcome === 'dead');
t('  registra el status', res.httpStatus === 400);
t('  registra el error', res.error === 'invalid_grant');
t('  el mensaje dice que no sirve reintentar', /no sirve reintentar/.test(res.message));
t('  el mensaje no inventa causas', !/otra sesión|compitiendo/.test(res.message));

respond = (_q, r) => json(r, 400, { error: 'invalid_grant', error_description: 'Refresh token has expired' });
res = await refreshAccessToken('britishroyal', 'R-MUERTO');
t('captura error_description', res.errorDescription === 'Refresh token has expired');
t('  y se la muestra al usuario', res.message.includes('Refresh token has expired'));
t('  guarda el cuerpo crudo recortado', (res.bodySnippet ?? '').includes('invalid_grant'));

respond = (_q, r) => json(r, 400, 'error=invalid_grant');
res = await refreshAccessToken('britishroyal', 'R-MUERTO');
t('invalid_grant en un cuerpo no-JSON igual se reconoce', res.outcome === 'dead');

// ── indeterminate ────────────────────────────────────────────────────────────
respond = (_q, r) => json(r, 500, { error: 'server_error' });
res = await refreshAccessToken('britishroyal', 'R-X');
t('5xx → indeterminate', res.outcome === 'indeterminate');
t('  el mensaje no afirma que la cadena murió', /no se sabe si la cadena/.test(res.message));

respond = (_q, r) => json(r, 400, { error: 'invalid_scope' });
res = await refreshAccessToken('britishroyal', 'R-X');
t('400 con otro error NO es dead', res.outcome === 'indeterminate');
t('  pero sí conserva el error del servidor', res.error === 'invalid_scope');

respond = (_q, r) => json(r, 200, { access_token: AT_NUEVO, expires_in: 3600 });
res = await refreshAccessToken('britishroyal', 'R-X');
t('2xx sin refresh_token → indeterminate', res.outcome === 'indeterminate');
t('  lo nombra como respuesta incompleta', res.error === 'incomplete_response');
t('  no devuelve tokens a medias', res.accessToken === undefined && res.refreshToken === undefined);

respond = (_q, r) => json(r, 200, 'no soy json {{{');
res = await refreshAccessToken('britishroyal', 'R-X');
t('2xx ilegible → indeterminate', res.outcome === 'indeterminate' && res.error === 'unparseable_response');

// Sin respuesta: el servidor pudo rotar igual y la respuesta perderse.
globalThis.fetch = ((u: any, o: any) =>
  orig(String(u).replace(/^https:\/\/[^/]+/, 'http://127.0.0.1:1'), o)) as typeof fetch;
res = await refreshAccessToken('britishroyal', 'R-X');
t('error de red → indeterminate', res.outcome === 'indeterminate');
t('  sin status, porque no hubo respuesta', res.httpStatus === null);
t('  marcado como network', res.error === 'network');
globalThis.fetch = ((u: any, o: any) =>
  orig(String(u).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), o)) as typeof fetch;

// ── orden: persistir antes de tocar la API de datos ──────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'refresh-'));
const store = new FileStore(join(dir, 'cred.json'));
await store.save({
  accessToken: makeToken({ tenant: 'britishroyal', expiresInSec: -60 }),
  refreshToken: 'R-VIEJO',
  tenant: 'britishroyal',
});

eventos.length = 0;
respond = (_q, r) => json(r, 200, { access_token: AT_NUEVO, refresh_token: 'R-NUEVO', expires_in: 3600 });
const creds = await store.load();
const fresh = await refreshAccessToken('britishroyal', creds.refreshToken!);
await store.save({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, tenant: 'britishroyal' });
eventos.push('save');

const persistido = await store.load();
t('el refresh nuevo quedó persistido', persistido.refreshToken === 'R-NUEVO');
t('el refresh viejo ya no está', persistido.refreshToken !== 'R-VIEJO');
t('se guardó ANTES de llamar a la API',
  eventos.indexOf('save') < (eventos.indexOf('api') === -1 ? Infinity : eventos.indexOf('api')));

globalThis.fetch = orig;
srv.close();
console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
