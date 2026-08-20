/**
 * Bitácora de la cadena (W6).
 *
 * La prueba central es la de redacción: la bitácora se sincroniza a la base de
 * conocimiento del proyecto como documento, así que un token completo filtrado
 * acá sale del contenedor. No se salta nunca.
 */
import { mkdtempSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, defaultJournalPath, redactSnippet, tail } from '../src/journal.js';
import { tokenClaims } from '../src/auth.js';
import { makeToken } from './maketoken.js';

let ok = 0, bad = 0;
const t = (n: string, c: boolean) => { c ? ok++ : bad++; console.log(`  ${c ? 'ok  ' : 'FALLA'} ${n}`); };

console.log('\n9. Bitácora de la cadena');

const dir = mkdtempSync(join(tmpdir(), 'journal-'));

// -- colas y rutas
t('tail devuelve los últimos 6', tail('abcdefghij') === 'efghij');
t('tail de un token corto lo devuelve entero', tail('abc') === 'abc');
t('tail de nada es null', tail(undefined) === null && tail('') === null);
t('la bitácora es hermana de las credenciales',
  defaultJournalPath('/home/claude/work/credenciales.json') === '/home/claude/work/credenciales.journal.jsonl');
t('defaultJournalPath resuelve rutas relativas',
  defaultJournalPath('cred.json').endsWith('/cred.journal.jsonl'));

// -- escritura básica
const jp = join(dir, 'nested', 'deep', 'cred.journal.jsonl');
const j = new Journal(jp, 'a3f9c1', 'scheduled', () => {});
const AT = makeToken({ tenant: 'britishroyal', expiresInSec: 3600 });
const claims = tokenClaims(AT);
// auth_time no lo pone makeToken; se simula una cadena de 7.5 h como la observada.
const conAuthTime = { ...claims, authTime: Math.floor(Date.now() / 1000) - 27000 };

j.append({ event: 'refresh', outcome: 'ok', tenant: 'britishroyal', oldRtTail: '8f2a1c', newRtTail: 'b71e04', httpStatus: 200, claims: conAuthTime });
t('crea los directorios que falten', existsSync(jp));
t('la bitácora nace con permisos 600', (statSync(jp).mode & 0o777) === 0o600);

const e0 = j.read()[0];
t('anota el runId de la corrida', e0.runId === 'a3f9c1');
t('anota el trigger', e0.trigger === 'scheduled');
t('anota el outcome', e0.outcome === 'ok');
t('ts es ISO 8601', !Number.isNaN(Date.parse(e0.ts)));
t('calcula chainAgeSec desde auth_time', Math.abs((e0.chainAgeSec ?? 0) - 27000) <= 2);
t('escribe accessTokenExp e iat como ISO', !!e0.accessTokenExp && !!e0.accessTokenIat);
t('sin auth_time, chainAgeSec es null', (() => {
  j.append({ event: 'reuse', tenant: 'britishroyal', oldRtTail: 'b71e04', claims });
  const e = j.read()[1];
  return e.authTime === null && e.chainAgeSec === null;
})());

// -- REDACCIÓN. Ni un token entero, en ningún campo, para ningún caso.
const RT_LARGO = 'CFDB8F1E2A4C6E8B0D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F08f2a1c';
const cuerpo2xxIncompleto = JSON.stringify({ access_token: AT, expires_in: 3600, token_type: 'Bearer' });
const cuerpoError = JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token has expired' });

const jr = new Journal(join(dir, 'red.journal.jsonl'), 'ff00aa', 'manual', () => {});
jr.append({ event: 'bootstrap', tenant: 'britishroyal', oldRtTail: tail(RT_LARGO), claims: conAuthTime });
jr.append({ event: 'refresh', outcome: 'indeterminate', tenant: 'britishroyal', oldRtTail: tail(RT_LARGO),
  httpStatus: 200, error: 'incomplete_response', bodySnippet: cuerpo2xxIncompleto, claims: conAuthTime });
jr.append({ event: 'refresh', outcome: 'dead', tenant: 'britishroyal', oldRtTail: tail(RT_LARGO),
  httpStatus: 400, error: 'invalid_grant', errorDescription: 'Refresh token has expired',
  bodySnippet: cuerpoError, claims: conAuthTime });
jr.append({ event: 'refresh', outcome: 'ok', tenant: 'britishroyal', oldRtTail: tail(RT_LARGO),
  newRtTail: tail(AT), httpStatus: 200, claims: conAuthTime });

const crudo = readFileSync(jr.path, 'utf8');
t('REDACCIÓN · el refresh token entero no aparece', !crudo.includes(RT_LARGO));
t('REDACCIÓN · el access token entero no aparece', !crudo.includes(AT));
t('REDACCIÓN · tampoco su payload', !crudo.includes(AT.split('.')[1]));
t('REDACCIÓN · ninguna línea trae algo con forma de JWT', !/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(crudo));
t('REDACCIÓN · ningún valor supera los 6 caracteres de cola', (() => {
  for (const e of jr.read())
    for (const k of ['oldRtTail', 'newRtTail'] as const)
      if (e[k] !== null && e[k]!.length > 6) return false;
  return true;
})());
t('pero sí queda la cola, que es lo que correlaciona', crudo.includes('8f2a1c'));
t('el error_description sí se guarda', crudo.includes('Refresh token has expired'));
t('redactSnippet recorta a 200', (redactSnippet('x'.repeat(500)) ?? '').length === 200);
t('redactSnippet deja el resto del cuerpo legible', (redactSnippet(cuerpo2xxIncompleto) ?? '').includes('expires_in'));

// -- las cuatro líneas del ciclo completo son correlacionables
const ciclo = jr.read();
t('el ciclo completo deja cuatro líneas', ciclo.length === 4);
t('  las cuatro comparten runId', ciclo.every((e) => e.runId === 'ff00aa'));
t('  y los eventos son bootstrap, refresh…', ciclo.map((e) => e.event).join(',') === 'bootstrap,refresh,refresh,refresh');
t('  con outcomes distinguibles', ciclo.map((e) => e.outcome ?? '-').join(',') === '-,indeterminate,dead,ok');

// -- colas ya vistas: así se detecta un bootstrap nuevo
t('knownTails junta las colas vistas', jr.knownTails().has('8f2a1c'));
t('una cola nueva no figura', !jr.knownTails().has('zzzzzz'));

// -- rotación a 200 líneas
const jrot = new Journal(join(dir, 'rot.journal.jsonl'), 'rot001', 'manual', () => {});
for (let i = 0; i < 260; i++) jrot.append({ event: 'reuse', tenant: 'britishroyal', oldRtTail: '8f2a1c' });
t('rota a 200 líneas', jrot.read().length === 200);
t('conserva las más recientes', readFileSync(jrot.path, 'utf8').split('\n').filter(Boolean).length === 200);

// -- robustez: escribir nunca puede voltear una corrida
let aviso = '';
const jmalo = new Journal(join(dir, 'rot.journal.jsonl', 'imposible', 'x.jsonl'), 'bad001', 'manual', (m) => { aviso = m; });
let lanzo = false;
try { jmalo.append({ event: 'reuse' }); } catch { lanzo = true; }
t('una bitácora que no se puede escribir avisa pero no lanza', !lanzo && aviso.includes('no se pudo anotar'));

writeFileSync(join(dir, 'corrupto.jsonl'), '{"event":"reuse","runId":"a"}\n{a medio escri\n');
const jcorr = new Journal(join(dir, 'corrupto.jsonl'), 'x', 'manual', () => {});
t('las líneas corruptas se saltan al leer', jcorr.read().length === 1);

console.log(`\n${ok} ok, ${bad} fallidas`);
if (bad) process.exit(1);
