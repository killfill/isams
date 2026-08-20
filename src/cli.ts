#!/usr/bin/env -S npx tsx
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  inspectToken, refreshAccessToken, tenantOf, tokenClaims, TokenError,
  type TokenClaims,
} from './auth.js';
import { FileStore, InlineStore, StoreError, type Credentials, type TokenStore } from './store.js';
import { defaultJournalPath, Journal, tail, type Trigger } from './journal.js';
import { bootstrapGuide } from './bootstrap.js';
import { extract, ExtractError } from './extract.js';
import { interpret } from './interpret.js';
import { RENDERERS, FORMATS, isFormat, type Format } from './render/index.js';
import { PROFILES, profileFor } from './profiles/index.js';
import type { RawExtract } from './types.js';

const USAGE = `
boletin — informe de notas desde el portal de apoderados iSAMS

  boletin --format <html|md|csv> --output <archivo>
  boletin auth refresh           renueva si hace falta y persiste. Una línea a stdout.
  boletin auth status            estado de las credenciales. No consume ni renueva nada.
  boletin auth bootstrap         cómo sacar credenciales del navegador, paso a paso.

  --format <f>           html | md | csv (requerido)
  --output <archivo>     Archivo de salida. También se acepta como argumento
                         posicional. Si se omite, escribe a stdout.

 Credenciales:
  --token-file <ruta>    Archivo JSON con las credenciales. Se reescribe en cada
                         renovación. Absoluta o relativa. Por defecto
                         credenciales.json en el directorio actual.
  --token <jwt>          Access token suelto. Dura 1 hora. Sin renovación.
                         Alternativa segura: variable ISAMS_TOKEN.
  --refresh-token <jwt>  Refresh token. Habilita la renovación automática.
                         Variable: ISAMS_REFRESH_TOKEN.
  --tenant <id>          Subdominio del colegio. Solo hace falta si únicamente
                         se dispone del refresh token (que es opaco).
  --no-refresh           No renovar aunque haya refresh token.
  --journal <ruta>       Bitácora de la cadena de refresh. Por defecto, hermana
                         del archivo de credenciales (…​.journal.jsonl).
  --trigger <t>          manual | scheduled. Queda anotado en la bitácora para
                         distinguir corridas. Por defecto manual.

  --parents-path <lista> Lista opaca del apoderado, p. ej. "1,9,8,4,7,6".
                         Se obtiene de la pestaña Network del portal.
  --profile <id>         Perfil de interpretación. Por defecto, según el tenant.
  --year <n>             Año académico para el título.
  --model <archivo>      Guarda además el ReportModel en JSON.
  --save-raw <archivo>   Guarda la extracción cruda (sin datos personales).
  --from-raw <archivo>   Lee de un archivo guardado en vez de llamar a la API.
                         No necesita token. Sirve para volver a renderizar en
                         otro formato sin gastar una extracción.
  --delay <ms>           Pausa entre llamadas a la API (por defecto 0).
  --strict               Sale con código 1 si hay avisos de severidad error.
  --quiet                Sin mensajes de progreso.

 Códigos de salida:
  0 ok · 2 argumentos inválidos · 3 credenciales rotas o ausentes (hace falta
  bootstrap manual, NO reintentar) · 4 error inesperado · 5 estado de la cadena
  indeterminado (puede estar viva o no, NO reintentar).

Perfiles disponibles: ${Object.keys(PROFILES).join(', ')}
`;

// ── 1. Validar parámetros ────────────────────────────────────────────────────

type Command = 'report' | 'auth-refresh' | 'auth-status' | 'auth-bootstrap';

interface Args {
  command: Command;
  /** Vacío cuando se lee de --from-raw o de un almacén. */
  token: string;
  refreshToken?: string;
  tokenFile?: string;
  journalPath?: string;
  trigger: Trigger;
  tenant?: string;
  noRefresh: boolean;
  format?: Format;
  output?: string;
  parentsPath: string;
  profileId?: string;
  year?: string;
  modelPath?: string;
  saveRawPath?: string;
  fromRawPath?: string;
  delayMs: number;
  strict: boolean;
  quiet: boolean;
}

const VALUE_FLAGS = new Set([
  'token', 'format', 'parents-path', 'profile', 'year', 'model', 'delay',
  'save-raw', 'from-raw', 'output',
  'refresh-token', 'token-file', 'journal', 'trigger', 'tenant',
]);
const BOOL_FLAGS = new Set(['strict', 'quiet', 'no-refresh']);

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error('Usa --help para ver las opciones.');
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  if (argv.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }

  let command: Command = 'report';
  if (argv[0] === 'auth') {
    const sub = argv[1];
    if (sub === 'refresh') command = 'auth-refresh';
    else if (sub === 'status') command = 'auth-status';
    else if (sub === 'bootstrap') command = 'auth-bootstrap';
    else fail(`Subcomando desconocido: "auth ${sub ?? ''}". Opciones: refresh, status, bootstrap.`);
    argv = argv.slice(2);
  }

  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`--${name} necesita un valor.`);
      flags.set(name, v);
    } else if (BOOL_FLAGS.has(name)) {
      flags.set(name, 'true');
    } else {
      fail(`Opción desconocida: --${name}`);
    }
  }

  const fromRaw = flags.get('from-raw');
  // El token en argv queda en el historial del shell y es visible en `ps`.
  const token = flags.get('token') ?? process.env.ISAMS_TOKEN;
  const refreshToken = flags.get('refresh-token') ?? process.env.ISAMS_REFRESH_TOKEN;
  let tokenFile = flags.get('token-file');

  const fuentes = [token || refreshToken, tokenFile].filter(Boolean).length;
  if (fromRaw && fuentes)
    fail('--from-raw lee de un archivo guardado: no necesita credenciales.');
  if (fuentes > 1)
    fail('Elige una sola vía de credenciales: --token/--refresh-token o --token-file.');
  // Sin nada indicado se usa el archivo por defecto. Que no exista no es un
  // error de argumentos: lo resuelve la carga, que sabe nombrar la ruta exacta.
  if (!fromRaw && fuentes === 0) tokenFile = 'credenciales.json';

  const trigger = flags.get('trigger') ?? 'manual';
  if (trigger !== 'manual' && trigger !== 'scheduled')
    fail(`--trigger acepta "manual" o "scheduled", llegó "${trigger}".`);

  let format: string | undefined;
  if (command === 'report') {
    if (fromRaw && !existsSync(fromRaw)) fail(`--from-raw: no existe ${resolve(fromRaw)}.`);
    format = flags.get('format');
    if (!format) fail('Falta --format.');
    if (!isFormat(format)) fail(`Formato inválido: "${format}". Opciones: ${FORMATS.join(', ')}.`);
    if (positional.length > 1)
      fail(`Se esperaba un solo archivo de salida, llegaron ${positional.length}.`);
    if (flags.has('output') && positional.length)
      fail('Usa --output o el argumento posicional, no ambos.');
  } else {
    if (flags.has('format')) fail(`"auth" no renderiza nada: --format no aplica.`);
    if (fromRaw) fail('"auth" trabaja sobre las credenciales: --from-raw no aplica.');
    if (positional.length) fail(`Argumento inesperado: "${positional[0]}".`);
  }

  const delayRaw = flags.get('delay');
  // Sin cabeceras de rate limit observadas; el default no penaliza.
  const delayMs = delayRaw === undefined ? 0 : Number(delayRaw);
  if (!Number.isFinite(delayMs) || delayMs < 0) fail('--delay debe ser un número de milisegundos.');

  return {
    command,
    token: token ?? '',
    refreshToken,
    tokenFile,
    journalPath: flags.get('journal'),
    trigger,
    tenant: flags.get('tenant'),
    noRefresh: flags.has('no-refresh'),
    format: format as Format | undefined,
    output: flags.get('output') ?? positional[0],
    // Valor observado en el tenant de referencia. Si la API responde 403 o una
    // lista vacía, hay que sacar el propio desde la pestaña Network del portal.
    parentsPath: flags.get('parents-path') ?? '1,9,8,4,7,6',
    profileId: flags.get('profile'),
    year: flags.get('year'),
    modelPath: flags.get('model'),
    saveRawPath: flags.get('save-raw'),
    fromRawPath: flags.get('from-raw'),
    delayMs,
    strict: flags.has('strict'),
    quiet: flags.has('quiet'),
  };
}

// ── 2. Piezas compartidas ────────────────────────────────────────────────────

/**
 * Error con código de salida propio. Los tres estados que el asistente que
 * llama tiene que poder distinguir sin adivinar —3 rota, 5 indeterminada— viajan
 * acá en vez de colapsar todos en un TokenError.
 */
class ExitError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** Identificador corto de la corrida: correlaciona líneas de la bitácora. */
const RUN_ID = randomBytes(3).toString('hex');

function buildStore(args: Args): TokenStore {
  if (args.tokenFile) return new FileStore(args.tokenFile);
  return new InlineStore({ accessToken: args.token || undefined, refreshToken: args.refreshToken });
}

/**
 * La bitácora vive junto a las credenciales. Con credenciales inline no hay
 * dónde ponerla salvo que se pida explícitamente con --journal.
 */
function buildJournal(args: Args, store: TokenStore, warn: (m: string) => void): Journal | null {
  const path = args.journalPath ?? (store instanceof FileStore ? defaultJournalPath(store.path) : null);
  return path ? new Journal(path, RUN_ID, args.trigger, warn) : null;
}

/** Margen antes de vencer. La extracción son ~26 peticiones secuenciales: con
 *  cinco minutos, una API lenta o un --delay alto vencen el token a mitad y
 *  desperdician la corrida y la renovación. */
const RENEW_BEFORE_SEC = 900;

const SUSPECT_AVISO =
  'aviso: La corrida anterior no pudo confirmar si la renovación se completó. ' +
  'Si esta falla con `invalid_grant`, la causa es esa.';

/**
 * Las instrucciones del bootstrap, enteras, con la ruta del almacén ya puesta.
 *
 * Van completas y no como un "corre tal otro comando": el momento en que este
 * texto hace falta es exactamente el momento en que el usuario no tiene nada, y
 * mandarlo a dar otra vuelta para leerlo solo agrega un paso. Peor con un modelo
 * de por medio: si el snippet no está a la vista, la tentación es reconstruirlo
 * de memoria, y el orden de sus pasos es funcional —una versión aproximada deja
 * el portal renovando por detrás y le quita la cadena al CLI en silencio.
 */
function bootstrapRemedy(store: TokenStore): string {
  return bootstrapGuide(store instanceof FileStore ? store.path : resolve('credenciales.json'));
}

function noCredentials(store: TokenStore): ExitError {
  const donde =
    store instanceof FileStore
      ? `  ruta: ${store.path}  (${existsSync(store.path) ? 'sin accessToken ni refreshToken' : 'no existe'})`
      : `  origen: ${store.name}  (sin accessToken ni refreshToken)`;
  return new ExitError(`no hay credenciales utilizables.\n${donde}\n\n${bootstrapRemedy(store)}`, 3);
}

interface Resolved {
  accessToken: string;
  tenant: string;
  /** true si esta corrida consumió el refresh token y persistió uno nuevo. */
  rotated: boolean;
}

/**
 * Devuelve un access token utilizable, renovando si hace falta.
 *
 * ❗ Orden crítico: el refresh token nuevo se persiste ANTES de tocar la API de
 * datos. Si el proceso muriera entre la renovación y el guardado, la cadena
 * quedaría rota y haría falta un bootstrap manual.
 */
async function resolveAccessToken(
  args: Args,
  store: TokenStore,
  journal: Journal | null,
  log: (m: string) => void
): Promise<Resolved> {
  const creds: Credentials = await store.load();
  if (!creds.accessToken && !creds.refreshToken) throw noCredentials(store);

  const claims: TokenClaims = tokenClaims(creds.accessToken);
  const oldRtTail = tail(creds.refreshToken);
  const tenantHint = tenantOf(creds.accessToken) ?? creds.tenant ?? args.tenant ?? null;

  // Una cola nunca vista antes es un bootstrap: alguien puso credenciales nuevas.
  if (oldRtTail && journal && !journal.knownTails().has(oldRtTail))
    journal.append({ event: 'bootstrap', tenant: tenantHint, oldRtTail, claims });

  // Lo primero que se dice, antes de cualquier otra cosa.
  if (creds.suspect) log(SUSPECT_AVISO);

  // ¿Sirve el access token que ya tenemos?
  if (creds.accessToken) {
    try {
      const info = inspectToken(creds.accessToken);
      if (info.secondsLeft > RENEW_BEFORE_SEC || args.noRefresh || !creds.refreshToken) {
        if (info.secondsLeft <= RENEW_BEFORE_SEC) {
          const min = Math.floor(info.secondsLeft / 60);
          log(
            min <= 5
              ? `aviso: al token le quedan ${min} min y no se renovará: la extracción podría cortarse a mitad.`
              : `Al token le quedan ${min} min y no se renovará.`
          );
        }
        journal?.append({ event: 'reuse', tenant: info.tenant, oldRtTail, claims });
        return { accessToken: creds.accessToken, tenant: info.tenant, rotated: false };
      }
      log(`El token vence en ${Math.floor(info.secondsLeft / 60)} min; renovando.`);
    } catch (e) {
      if (!creds.refreshToken || args.noRefresh) throw e;
      log(`Access token inservible (${(e as Error).message.slice(0, 60)}…); renovando.`);
    }
  }

  if (!creds.refreshToken)
    throw new ExitError('No hay refresh token: no se puede renovar. Extrae uno nuevo del portal.', 3);
  if (args.noRefresh)
    throw new ExitError('El access token no sirve y --no-refresh impide renovarlo.', 3);
  if (!store.writable)
    log(
      'aviso: las credenciales vienen de un flag y no se pueden reescribir. La rotación ' +
        'invalidará este refresh token: la próxima corrida fallará. Usa --token-file.'
    );

  const tenant = tenantHint;
  if (!tenant)
    throw new ExitError(
      'No se puede deducir el tenant: el refresh token es opaco y no hay access token legible. ' +
        'Pasa --tenant o guarda "tenant" junto a las credenciales.',
      3
    );

  const r = await refreshAccessToken(tenant, creds.refreshToken);

  if (r.outcome === 'ok') {
    // Persistir PRIMERO. Recién después se usa el token. `suspect` se omite: un
    // ok es la única evidencia de que la cadena está sana.
    await store.save({
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: new Date(Date.now() + (r.expiresIn ?? 3600) * 1000).toISOString(),
      tenant,
      refreshTokenPrevious: oldRtTail ?? undefined,
    });
    journal?.append({
      event: 'refresh',
      outcome: 'ok',
      tenant,
      oldRtTail,
      newRtTail: tail(r.refreshToken),
      httpStatus: r.httpStatus,
      claims: tokenClaims(r.accessToken),
    });
    log(`Credenciales renovadas y guardadas en ${store.name}.`);
    return { accessToken: r.accessToken!, tenant, rotated: true };
  }

  journal?.append({
    event: 'refresh',
    outcome: r.outcome,
    tenant,
    oldRtTail,
    newRtTail: null,
    httpStatus: r.httpStatus,
    error: r.error,
    errorDescription: r.errorDescription,
    bodySnippet: r.bodySnippet,
    claims,
  });

  // `dead` deja el archivo intacto: el servidor ya dijo que no sirve y
  // sobrescribirlo solo destruiría la evidencia. `indeterminate` marca la duda.
  if (r.outcome === 'indeterminate' && store.writable) {
    try {
      await store.save({ ...creds, suspect: true });
    } catch (e) {
      log(`aviso: no se pudo marcar las credenciales como sospechosas: ${(e as Error).message}`);
    }
  }

  const bitacora = journal ? `\n  bitácora: ${journal.path}` : '';
  // `dead` es exactamente el caso en que hay que volver al navegador, así que el
  // remedio va acá y no a dos comandos de distancia. `indeterminate` no lo lleva:
  // mandar a rehacer el bootstrap una cadena que quizá sigue viva es destruirla.
  const remedio = r.outcome === 'dead' ? `\n\n${bootstrapRemedy(store)}` : '';
  throw new ExitError(r.message + bitacora + remedio, r.outcome === 'dead' ? 3 : 5);
}

// ── 3. Subcomandos auth ──────────────────────────────────────────────────────

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Las instrucciones del bootstrap, con la ruta pedida ya sustituida.
 *
 * No lee credenciales, no llama a la red y no escribe nada: es lo que se corre
 * justamente cuando no hay credenciales que leer. Vive en el CLI y no solo en
 * SKILL.md para que quien lo corre en su terminal y el modelo que lee el skill
 * reciban exactamente el mismo texto, sin una segunda copia que se quede vieja.
 */
async function cmdAuthBootstrap(args: Args): Promise<void> {
  const store = buildStore(args);
  const path = store instanceof FileStore ? store.path : resolve('credenciales.json');
  process.stdout.write(bootstrapGuide(path) + '\n');
}

/** W5: renueva si hace falta, persiste, y deja una línea legible por máquina. */
async function cmdAuthRefresh(args: Args, log: (m: string) => void): Promise<void> {
  const store = buildStore(args);
  const journal = buildJournal(args, store, log);
  const { accessToken, rotated } = await resolveAccessToken(args, store, journal, log);

  const after = await store.load();
  const exp = tokenClaims(accessToken).exp;
  process.stdout.write(
    `rotated: ${rotated ? 'yes' : 'no '} · rtTail: ${tail(after.refreshToken) ?? '—'} · ` +
      `expiresAt: ${exp === null ? '—' : isoSec(new Date(exp * 1000))}\n`
  );
}

function humanAge(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** W9: solo lee. No renueva, no consume, no escribe. */
async function cmdAuthStatus(args: Args, log: (m: string) => void): Promise<void> {
  const store = buildStore(args);
  const journal = buildJournal(args, store, log);
  const creds = await store.load();
  if (!creds.accessToken && !creds.refreshToken) throw noCredentials(store);

  const c = tokenClaims(creds.accessToken);
  const now = Date.now();
  const row = (k: string, v: string) => `${k.padEnd(19)}${v}`;
  const out: string[] = [];

  out.push(row('tenant', creds.tenant ?? c.tenant ?? '—'));

  if (!creds.accessToken) out.push(row('access token', 'ausente'));
  else if (c.exp === null) out.push(row('access token', 'ilegible (no es un JWT que podamos leer)'));
  else {
    const left = Math.round((c.exp * 1000 - now) / 60000);
    const when = isoSec(new Date(c.exp * 1000));
    out.push(row('access token', left > 0 ? `vence en ${left} min (${when})` : `venció hace ${-left} min (${when})`));
  }

  out.push(
    row(
      'auth_time',
      c.authTime === null
        ? '—'
        : `${isoSec(new Date(c.authTime * 1000))}  (edad de la cadena: ${humanAge(Math.round(now / 1000 - c.authTime))})`
    )
  );

  out.push(row('refresh token', creds.refreshToken ? `…${tail(creds.refreshToken)}` : 'ausente'));
  if (creds.refreshTokenPrevious) out.push(row('  anterior', `…${creds.refreshTokenPrevious}`));

  out.push(row('estado', creds.suspect ? 'SOSPECHOSO' : 'ok'));
  if (creds.suspect)
    out.push(
      '                   la corrida anterior no pudo confirmar si su renovación se completó;\n' +
        '                   este refresh token puede estar vivo o muerto. Un `invalid_grant`\n' +
        '                   en la próxima corrida tiene ahí su causa.'
    );

  const entries = journal?.read() ?? [];
  const refreshes = entries.filter((e) => e.event === 'refresh');
  const last = refreshes[refreshes.length - 1];
  out.push(row('última renovación', last ? `${last.ts}  (${last.outcome})` : '—'));

  const desde = now - 30 * 24 * 3600 * 1000;
  const recientes = refreshes.filter((e) => Date.parse(e.ts) >= desde);
  const n = (o: string) => recientes.filter((e) => e.outcome === o).length;
  const ind = n('indeterminate');
  out.push(
    row(
      'renovaciones',
      `${n('ok')} ok · ${n('dead')} muertas · ${ind} ${ind === 1 ? 'indeterminada' : 'indeterminadas'}` +
        '  (últimos 30 días)'
    )
  );

  if (journal) out.push(row('bitácora', `${journal.path}${existsSync(journal.path) ? '' : '  (todavía no existe)'}`));

  process.stdout.write(out.join('\n') + '\n');
}

// ── 4. Informe ───────────────────────────────────────────────────────────────

async function cmdReport(args: Args, log: (m: string) => void): Promise<void> {
  // ── Credenciales: cargar, renovar si hace falta, persistir ─────────────────
  let tenant: string;
  let accessToken = '';

  if (args.fromRawPath) {
    const saved: RawExtract = JSON.parse(readFileSync(args.fromRawPath, 'utf8'));
    if (saved.schemaVersion !== '1.0') fail(`schemaVersion no soportada: ${saved.schemaVersion}`);
    tenant = saved.tenant;
  } else {
    const store = buildStore(args);
    const journal = buildJournal(args, store, log);
    const resolved = await resolveAccessToken(args, store, journal, log);
    accessToken = resolved.accessToken;
    const info = inspectToken(accessToken);
    tenant = info.tenant;
    log(`Tenant ${tenant} · token válido por ${Math.floor(info.secondsLeft / 60)} min.`);
    if (info.secondsLeft < 120)
      log('aviso: al token le quedan menos de 2 minutos; la extracción podría cortarse a mitad.');
  }

  const profile = profileFor(args.profileId ?? tenant);
  if (!profile)
    fail(
      args.profileId
        ? `Perfil desconocido: ${args.profileId}. Disponibles: ${Object.keys(PROFILES).join(', ')}.`
        : `No hay perfil de interpretación para el tenant "${tenant}". Escribe uno en src/profiles/ (ver README) o pasa --profile.`
    );

  // ── Extraer e interpretar ──────────────────────────────────────────────────
  const raw: RawExtract = args.fromRawPath
    ? JSON.parse(readFileSync(args.fromRawPath, 'utf8'))
    : await extract({
        tenant,
        accessToken,
        parentsPath: args.parentsPath,
        delayMs: args.delayMs,
        onProgress: log,
      });

  if (args.fromRawPath) log(`Leído ${args.fromRawPath} (extraído ${raw.extractedAt}).`);
  if (args.saveRawPath) {
    writeFileSync(args.saveRawPath, JSON.stringify(raw, null, 1));
    log(`Extracción guardada en ${args.saveRawPath}.`);
  }

  const model = interpret(raw, profile);
  const v = model.verification;
  log(
    `${model.students.length} alumnos · ${v.periodsChecked} periodos · ` +
      `${v.reproduced} reproducidos, ${v.corrected} corregidos, ${v.estimated} estimados, ${v.mismatches} desajustes.`
  );
  for (const w of model.warnings.filter((x) => x.severity !== 'info'))
    log(`  [${w.severity}] ${w.code} · ${w.student}${w.subject ? ' · ' + w.subject : ''}: ${w.message}`);

  // ── Renderizar y escribir ──────────────────────────────────────────────────
  const out = RENDERERS[args.format!].render(model, profile, { year: args.year });

  if (args.output) {
    writeFileSync(args.output, out);
    log(`Escrito ${args.output} (${out.length} bytes).`);
  } else {
    process.stdout.write(out);
  }
  if (args.modelPath) {
    writeFileSync(args.modelPath, JSON.stringify(model, null, 1));
    log(`Modelo guardado en ${args.modelPath}.`);
  }

  const errors = model.warnings.filter((w) => w.severity === 'error').length;
  if (errors && args.strict) {
    console.error(`\n${errors} error(es): el informe se generó pero NO es confiable.`);
    process.exit(1);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Si la salida va a stdout, el progreso no puede contaminarla: todo a stderr.
  const log = args.quiet ? () => {} : (m: string) => console.error(m);

  if (args.command === 'auth-bootstrap') return cmdAuthBootstrap(args);
  if (args.command === 'auth-refresh') return cmdAuthRefresh(args, log);
  if (args.command === 'auth-status') return cmdAuthStatus(args, log);
  return cmdReport(args, log);
}

main().catch((e) => {
  if (e instanceof ExitError) {
    console.error(`error: ${e.message}`);
    process.exit(e.code);
  }
  if (e instanceof TokenError || e instanceof ExtractError || e instanceof StoreError) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  console.error('error inesperado:', e instanceof Error ? e.message : e);
  process.exit(4);
});
