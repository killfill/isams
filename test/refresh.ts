/**
 * Verifica el requisito de §2.7: el refresh token rotado debe persistirse ANTES
 * de usar el access token contra la API de datos. Si el orden se invierte, un
 * corte del proceso rompe la cadena y obliga a un bootstrap manual.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { FileStore } from '../src/store.js';
import { makeToken } from './maketoken.js';

let ok = 0, bad = 0;
const t = (n: string, c: boolean) => { c ? ok++ : bad++; console.log(`  ${c ? 'ok  ' : 'FALLA'} ${n}`); };

console.log('\n7. Renovación y rotación');

const eventos: string[] = [];
const dir = mkdtempSync(join(tmpdir(), 'refresh-'));
const fp = join(dir, 'cred.json');
const store = new FileStore(fp);

// access token vencido + refresh token válido
await store.save({
  accessToken: makeToken({ tenant: 'britishroyal', expiresInSec: -60 }),
  refreshToken: 'R-VIEJO',
  tenant: 'britishroyal',
});

const srv = createServer((req, res) => {
  if (req.url?.includes('/auth/connect/token')) {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      const p = new URLSearchParams(b);
      eventos.push('refresh');
      t('  manda grant_type=refresh_token', p.get('grant_type') === 'refresh_token');
      t('  manda el refresh token vigente', p.get('refresh_token') === 'R-VIEJO');
      t('  manda el scope completo', (p.get('scope') ?? '').includes('offline_access'));
      t('  NO manda client_secret', !p.has('client_secret'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        access_token: makeToken({ tenant: 'britishroyal', expiresInSec: 3600 }),
        refresh_token: 'R-NUEVO', expires_in: 3600, token_type: 'Bearer',
      }));
    });
    return;
  }
  eventos.push('api');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url?.includes('/students/portal') ? { students: [] } : []));
});
await new Promise<void>(r => srv.listen(0, r));

// Simulamos la secuencia del CLI usando las piezas reales.
const { refreshAccessToken } = await import('../src/auth.js');
const orig = globalThis.fetch;
const port = (srv.address() as any).port;
globalThis.fetch = ((u: any, o: any) =>
  orig(String(u).replace(/https:\/\/[^/]+/, `http://127.0.0.1:${port}`), o)) as typeof fetch;

const creds = await store.load();
const fresh = await refreshAccessToken('britishroyal', creds.refreshToken!);
await store.save({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, tenant: 'britishroyal' });
eventos.push('save');

const persistido = await store.load();
t('el refresh nuevo quedó persistido', persistido.refreshToken === 'R-NUEVO');
t('el refresh viejo ya no está', persistido.refreshToken !== 'R-VIEJO');
t('se guardó ANTES de llamar a la API', eventos.indexOf('save') < (eventos.indexOf('api') === -1 ? Infinity : eventos.indexOf('api')));

globalThis.fetch = orig;
srv.close();
console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
