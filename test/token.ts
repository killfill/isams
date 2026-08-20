/** inspectToken: la puerta que decide si un token sirve, antes de gastar red. */
import { inspectToken, tokenClaims, tenantOf, TokenError } from '../src/auth.js';
import { makeToken } from './maketoken.js';

let ok = 0, bad = 0;
const t = (n: string, c: boolean) => { c ? ok++ : bad++; console.log(`  ${c ? 'ok  ' : 'FALLA'} ${n}`); };
const lanza = (fn: () => unknown, re: RegExp) => {
  try { fn(); return false; } catch (e) { return e instanceof TokenError && re.test((e as Error).message); }
};

console.log('\n8. Inspección del access token');

const bueno = makeToken({ tenant: 'britishroyal', expiresInSec: 3600 });
const info = inspectToken(bueno);
t('token válido: saca el tenant', info.tenant === 'britishroyal');
t('token válido: saca los segundos restantes', info.secondsLeft > 3500 && info.secondsLeft <= 3600);
t('token válido: saca el userCode', info.userCode === 'TEST');

t('vencido: lanza y dice hace cuánto',
  lanza(() => inspectToken(makeToken({ expiresInSec: -600 })), /expiró hace 10 min/));
t('audiencia equivocada: lanza',
  lanza(() => inspectToken(makeToken({ audience: ['Authentication Server'] })), /audiencia "REST API"/));
t('sin el scope de la API: lanza',
  lanza(() => inspectToken(makeToken({ scope: ['openid', 'offline_access'] })), /scope "iSAMS.CloudPortals.Api"/));
t('emisor ajeno: lanza',
  lanza(() => inspectToken(makeToken({ issuer: 'https://example.com/auth' })), /no parece de iSAMS Cloud/));
t('malformado: lanza',
  lanza(() => inspectToken('no-es-jwt'), /no tiene forma de JWT/));
t('payload no decodificable: lanza',
  lanza(() => inspectToken('a.!!!.c'), /No se pudo decodificar|no parece de iSAMS/));

// tokenClaims mira sin juzgar: tiene que describir tokens que inspectToken rechaza.
const vencido = makeToken({ expiresInSec: -600 });
const c = tokenClaims(vencido);
t('tokenClaims lee un token vencido sin lanzar', c.exp !== null && c.exp * 1000 < Date.now());
t('tokenClaims saca el tenant', c.tenant === 'britishroyal');
t('tokenClaims con basura devuelve nulls', tokenClaims('no-es-jwt').exp === null);
t('tokenClaims sin token devuelve nulls', tokenClaims(undefined).tenant === null);
t('tenantOf funciona sobre un token vencido', tenantOf(vencido) === 'britishroyal');

console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
