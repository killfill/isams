import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { FileStore, HttpStore, InlineStore } from '../src/store.js';
import { makeToken } from './maketoken.js';

let ok = 0, bad = 0;
const t = (name: string, cond: boolean) => { cond ? ok++ : bad++; console.log(`  ${cond ? 'ok  ' : 'FALLA'} ${name}`); };

console.log('\n6. Almacén de credenciales');

// -- FileStore
const dir = mkdtempSync(join(tmpdir(), 'store-'));
const fp = join(dir, 'cred.json');
const fs = new FileStore(fp);
t('archivo inexistente devuelve vacío', Object.keys(await fs.load()).length === 0);
await fs.save({ accessToken: 'a1', refreshToken: 'r1', tenant: 'x' });
t('guarda y relee', (await fs.load()).refreshToken === 'r1');
await fs.save({ accessToken: 'a2', refreshToken: 'r2', tenant: 'x' });
t('sobrescribe con el rotado', (await fs.load()).refreshToken === 'r2');
t('no deja temporales', !existsSync(join(dir, '.tmp')));
t('permisos 600', (statSync(fp).mode & 0o777) === 0o600);
t('FileStore es escribible', fs.writable);
t('InlineStore NO es escribible', !new InlineStore({}).writable);

// -- HttpStore contra un servidor real
let stored: any = { accessToken: 'srvA', refreshToken: 'srvR', tenant: 'britishroyal' };
let lastAuth = '';
const srv = createServer((req, res) => {
  lastAuth = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '');
  if (req.method === 'GET') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify(stored)); }
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => { stored = JSON.parse(b); res.statusCode = 204; res.end(); });
});
await new Promise<void>(r => srv.listen(0, r));
const url = `http://127.0.0.1:${(srv.address() as any).port}/token`;

const hs = new HttpStore({ url, apiKey: 'K123' });
const got = await hs.load();
t('HttpStore lee del endpoint', got.refreshToken === 'srvR');
t('manda Bearer en Authorization', lastAuth === 'Bearer K123');
await hs.save({ accessToken: 'nuevoA', refreshToken: 'nuevoR', tenant: 'britishroyal' });
t('HttpStore persiste con POST', stored.refreshToken === 'nuevoR');

const hs2 = new HttpStore({ url, apiKey: 'K123', header: 'X-API-Key' });
await hs2.load();
t('cabecera alternativa manda la clave cruda', lastAuth === 'K123');

// snake_case y envoltorio {data}
stored = { data: { access_token: 'sA', refresh_token: 'sR' } };
t('acepta snake_case y {data}', (await hs.load()).refreshToken === 'sR');
srv.close();

console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
