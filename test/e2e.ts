import { start } from './mockserver.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

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
  try {
    const out = execFileSync('npx', ['tsx', 'src/cli.ts', ...args],
      { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '' };
  } catch (e: any) {
    return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

let pass = 0, failn = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { failn++; console.log(`  FAIL ${name} ${detail}`); }
};

console.log('\n1. Validación de parámetros');
check('sin --token falla con código 2', run(['--format', 'html']).code === 2);
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

stop();
console.log(`\n${pass} ok, ${failn} fallidas`);
process.exit(failn ? 1 : 0);
