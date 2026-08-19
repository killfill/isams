#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectToken, refreshAccessToken, tenantOf, TokenError } from './auth.js';
import { FileStore, HttpStore, InlineStore, StoreError, type Credentials, type TokenStore } from './store.js';
import { extract, ExtractError } from './extract.js';
import { interpret } from './interpret.js';
import { RENDERERS, FORMATS, isFormat, type Format } from './render/index.js';
import { PROFILES, profileFor } from './profiles/index.js';
import type { RawExtract } from './types.js';

const USAGE = `
boletin — informe de notas desde el portal de apoderados iSAMS

  boletin --format <html|md|csv> --output <archivo>

  --format <f>           html | md | csv (requerido)
  --output <archivo>     Archivo de salida. También se acepta como argumento
                         posicional. Si se omite, escribe a stdout.

 Credenciales (elige UNA vía):
  --token <jwt>          Access token suelto. Dura 1 hora. Sin renovación.
                         Alternativa segura: variable ISAMS_TOKEN.
  --refresh-token <jwt>  Refresh token. Habilita la renovación automática.
                         Variable: ISAMS_REFRESH_TOKEN.
  --token-file <ruta>    Archivo JSON con las credenciales. Se reescribe en
                         cada renovación. Recomendado para uso desatendido.
  --token-endpoint <url> Endpoint REST: GET para leer, POST para guardar.
  --token-api-key <k>    Clave del endpoint. Variable: ISAMS_TOKEN_API_KEY.
  --token-header <n>     Cabecera de la clave. Por defecto Authorization
                         (se envía como "Bearer <clave>"); con otro nombre se
                         envía la clave cruda.
  --tenant <id>          Subdominio del colegio. Solo hace falta si únicamente
                         se dispone del refresh token (que es opaco).
  --no-refresh           No renovar aunque haya refresh token.

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

Perfiles disponibles: ${Object.keys(PROFILES).join(', ')}
`;

// ── 1. Validar parámetros ────────────────────────────────────────────────────

interface Args {
  /** Vacío cuando se lee de --from-raw o de un almacén. */
  token: string;
  refreshToken?: string;
  tokenFile?: string;
  tokenEndpoint?: string;
  tokenApiKey?: string;
  tokenHeader?: string;
  tenant?: string;
  noRefresh: boolean;
  format: Format;
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
  'refresh-token', 'token-file', 'token-endpoint', 'token-api-key', 'token-header', 'tenant',
]);
const BOOL_FLAGS = new Set(['strict', 'quiet', 'no-refresh']);

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error('Usa --help para ver las opciones.');
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (name === 'help') {
      console.log(USAGE);
      process.exit(0);
    } else if (VALUE_FLAGS.has(name)) {
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
  const tokenFile = flags.get('token-file');
  const tokenEndpoint = flags.get('token-endpoint');

  const fuentes = [token || refreshToken, tokenFile, tokenEndpoint].filter(Boolean).length;
  if (fromRaw && fuentes)
    fail('--from-raw lee de un archivo guardado: no necesita credenciales.');
  if (!fromRaw && fuentes === 0)
    fail(
      'Faltan credenciales. Elige una vía: --token / ISAMS_TOKEN, --token-file, ' +
        'o --token-endpoint. Con --from-raw no se necesita ninguna.'
    );
  if (fuentes > 1)
    fail('Elige una sola vía de credenciales (--token, --token-file o --token-endpoint).');
  if (tokenEndpoint && !(flags.get('token-api-key') ?? process.env.ISAMS_TOKEN_API_KEY))
    fail('--token-endpoint necesita --token-api-key (o la variable ISAMS_TOKEN_API_KEY).');

  const format = flags.get('format');
  if (!format) fail('Falta --format.');
  if (!isFormat(format)) fail(`Formato inválido: "${format}". Opciones: ${FORMATS.join(', ')}.`);

  if (positional.length > 1) fail(`Se esperaba un solo archivo de salida, llegaron ${positional.length}.`);
  if (flags.has('output') && positional.length)
    fail('Usa --output o el argumento posicional, no ambos.');

  const delayRaw = flags.get('delay');
  // Sin cabeceras de rate limit observadas; el default no penaliza.
  const delayMs = delayRaw === undefined ? 0 : Number(delayRaw);
  if (!Number.isFinite(delayMs) || delayMs < 0) fail('--delay debe ser un número de milisegundos.');

  return {
    token: token ?? '',
    refreshToken,
    tokenFile,
    tokenEndpoint,
    tokenApiKey: flags.get('token-api-key') ?? process.env.ISAMS_TOKEN_API_KEY,
    tokenHeader: flags.get('token-header'),
    tenant: flags.get('tenant'),
    noRefresh: flags.has('no-refresh'),
    format,
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

function buildStore(args: Args): TokenStore {
  if (args.tokenEndpoint)
    return new HttpStore({ url: args.tokenEndpoint, apiKey: args.tokenApiKey, header: args.tokenHeader });
  if (args.tokenFile) return new FileStore(args.tokenFile);
  return new InlineStore({ accessToken: args.token || undefined, refreshToken: args.refreshToken });
}

/** Margen antes de vencer. La extracción son ~26 peticiones. */
const RENEW_BEFORE_SEC = 300;

/**
 * Devuelve un access token utilizable, renovando si hace falta.
 *
 * ❗ Orden crítico (§2.7): el refresh token nuevo se persiste ANTES de tocar la
 * API de datos. Si el proceso muriera entre la renovación y el guardado, la
 * cadena quedaría rota y haría falta un bootstrap manual.
 */
async function resolveAccessToken(
  args: Args,
  store: TokenStore,
  log: (m: string) => void
): Promise<string> {
  const creds: Credentials = await store.load();
  if (!creds.accessToken && !creds.refreshToken)
    throw new TokenError(`El almacén (${store.name}) no tiene credenciales. Haz el bootstrap: ver README.`);

  // ¿Sirve el access token que ya tenemos?
  if (creds.accessToken) {
    try {
      const info = inspectToken(creds.accessToken);
      if (info.secondsLeft > RENEW_BEFORE_SEC || args.noRefresh || !creds.refreshToken) {
        if (info.secondsLeft <= RENEW_BEFORE_SEC)
          log(`aviso: al token le quedan ${Math.floor(info.secondsLeft / 60)} min y no se renovará.`);
        return creds.accessToken;
      }
      log(`El token vence en ${Math.floor(info.secondsLeft / 60)} min; renovando.`);
    } catch (e) {
      if (!creds.refreshToken || args.noRefresh) throw e;
      log(`Access token inservible (${(e as Error).message.slice(0, 60)}…); renovando.`);
    }
  }

  if (!creds.refreshToken)
    throw new TokenError('No hay refresh token: no se puede renovar. Extrae uno nuevo del portal.');
  if (args.noRefresh) throw new TokenError('El access token no sirve y --no-refresh impide renovarlo.');
  if (!store.writable)
    log(
      'aviso: las credenciales vienen de un flag y no se pueden reescribir. La rotación (§2.7) ' +
        'invalidará este refresh token: la próxima corrida fallará. Usa --token-file o --token-endpoint.'
    );

  const tenant = tenantOf(creds.accessToken) ?? creds.tenant ?? args.tenant;
  if (!tenant)
    throw new TokenError(
      'No se puede deducir el tenant: el refresh token es opaco y no hay access token legible. ' +
        'Pasa --tenant o guarda "tenant" junto a las credenciales.'
    );
  const fresh = await refreshAccessToken(tenant, creds.refreshToken);

  // Persistir PRIMERO. Recién después se usa el token.
  await store.save({
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: new Date(Date.now() + fresh.expiresIn * 1000).toISOString(),
    tenant,
  });
  log(`Credenciales renovadas y guardadas en ${store.name}.`);
  return fresh.accessToken;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Si la salida va a stdout, el progreso no puede contaminarla: todo a stderr.
  const log = args.quiet ? () => {} : (m: string) => console.error(m);

  // ── 2. Credenciales: cargar, renovar si hace falta, persistir ──────────────
  let tenant: string;
  let accessToken = '';

  if (args.fromRawPath) {
    const saved: RawExtract = JSON.parse(readFileSync(args.fromRawPath, 'utf8'));
    if (saved.schemaVersion !== '1.0') fail(`schemaVersion no soportada: ${saved.schemaVersion}`);
    tenant = saved.tenant;
  } else {
    const store = buildStore(args);
    accessToken = await resolveAccessToken(args, store, log);
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

  // ── 3. Extraer e interpretar ───────────────────────────────────────────────
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

  // ── 4. Renderizar ──────────────────────────────────────────────────────────
  const out = RENDERERS[args.format].render(model, profile, { year: args.year });

  // ── 5. Escribir ────────────────────────────────────────────────────────────
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

main().catch((e) => {
  if (e instanceof TokenError || e instanceof ExtractError || e instanceof StoreError) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  console.error('error inesperado:', e instanceof Error ? e.message : e);
  process.exit(4);
});
