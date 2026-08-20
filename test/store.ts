import { mkdtempSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { FileStore, InlineStore } from '../src/store.js';
import * as store from '../src/store.js';

let ok = 0, bad = 0;
const t = (name: string, cond: boolean) => { cond ? ok++ : bad++; console.log(`  ${cond ? 'ok  ' : 'FALLA'} ${name}`); };

console.log('\n6. Almacén de credenciales');

const dir = mkdtempSync(join(tmpdir(), 'store-'));
const fp = join(dir, 'cred.json');
const fs = new FileStore(fp);
t('archivo inexistente devuelve vacío', Object.keys(await fs.load()).length === 0);
await fs.save({ accessToken: 'a1', refreshToken: 'r1', tenant: 'x' });
t('guarda y relee', (await fs.load()).refreshToken === 'r1');
await fs.save({ accessToken: 'a2', refreshToken: 'r2', tenant: 'x' });
t('sobrescribe con el rotado', (await fs.load()).refreshToken === 'r2');
t('no deja temporales', !readdirSync(dir).some((f) => f.endsWith('.tmp')));
t('permisos 600', (statSync(fp).mode & 0o777) === 0o600);
t('FileStore es escribible', fs.writable);
t('InlineStore NO es escribible', !new InlineStore({}).writable);

// W8: el endpoint HTTP se fue entero, junto con su clave en argv.
t('HttpStore ya no existe', !('HttpStore' in store));

// W4: los campos que hacen diagnosticable una rotación sospechosa.
await fs.save({ accessToken: 'a3', refreshToken: 'r3', tenant: 'x', suspect: true, refreshTokenPrevious: 'abc123' });
const conDudas = await fs.load();
t('persiste suspect', conDudas.suspect === true);
t('persiste la cola del refresh anterior', conDudas.refreshTokenPrevious === 'abc123');
t('la cola anterior es solo una cola', (conDudas.refreshTokenPrevious ?? '').length === 6);
await fs.save({ accessToken: 'a4', refreshToken: 'r4', tenant: 'x' });
t('un guardado sin suspect lo limpia', (await fs.load()).suspect === undefined);

// W2: rutas absolutas y directorios que todavía no existen.
const rel = new FileStore('cred-relativo.json');
t('resuelve la ruta relativa a absoluta', isAbsolute(rel.path));
t('el nombre del almacén usa la ruta absoluta', rel.name.includes(rel.path));

const anidado = join(dir, 'work', 'creds', 'credenciales.json');
const fs2 = new FileStore(anidado);
t('directorio inexistente: load devuelve vacío, no error', Object.keys(await fs2.load()).length === 0);
await fs2.save({ accessToken: 'x', refreshToken: 'y', tenant: 'z' });
t('crea los directorios intermedios que falten', existsSync(anidado));
t('el archivo anidado nace con permisos 600', (statSync(anidado).mode & 0o777) === 0o600);
t('y se puede releer', (await fs2.load()).refreshToken === 'y');

// Escritura atómica: nunca se ve un archivo a medio escribir.
t('el contenido guardado es JSON completo', (() => {
  try { JSON.parse(readFileSync(anidado, 'utf8')); return true; } catch { return false; }
})());

console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
