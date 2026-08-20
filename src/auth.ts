/**
 * Validación local del access token, antes de gastar llamadas a la API.
 *
 * No se verifica la firma: para eso haría falta el JWKS del servidor, y de todos
 * modos el servidor es la autoridad final. Lo que sí se hace es fallar rápido y
 * con un mensaje útil cuando el token está vencido o le falta un scope, en vez
 * de dejar que la primera petición devuelva un 401 opaco.
 */

export interface TokenInfo {
  tenant: string;
  expiresAt: Date;
  secondsLeft: number;
  userCode: string | null;
}

const REQUIRED_AUDIENCE = 'REST API';
const REQUIRED_SCOPE = 'iSAMS.CloudPortals.Api';

export class TokenError extends Error {}

function decodePayload(token: string): Record<string, unknown> {
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw new TokenError('El token no tiene forma de JWT (se esperaban 3 segmentos separados por punto).');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('No se pudo decodificar el payload del token.');
  }
}

export function inspectToken(token: string, now = new Date()): TokenInfo {
  const p = decodePayload(token);

  const iss = typeof p.iss === 'string' ? p.iss : '';
  // https://{tenant}.isams.cloud/auth -> {tenant}
  const tenant = iss.match(/^https:\/\/([^.]+)\.isams\.cloud\/auth$/)?.[1];
  if (!tenant) throw new TokenError(`El emisor del token no parece de iSAMS Cloud: "${iss}".`);

  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes(REQUIRED_AUDIENCE))
    throw new TokenError(`El token no sirve para la API de datos: le falta la audiencia "${REQUIRED_AUDIENCE}".`);

  const scope = Array.isArray(p.scope) ? p.scope : String(p.scope ?? '').split(' ');
  if (!scope.includes(REQUIRED_SCOPE))
    throw new TokenError(`Al token le falta el scope "${REQUIRED_SCOPE}".`);

  const exp = typeof p.exp === 'number' ? p.exp : 0;
  const expiresAt = new Date(exp * 1000);
  const secondsLeft = Math.round((expiresAt.getTime() - now.getTime()) / 1000);
  if (secondsLeft <= 0)
    throw new TokenError(
      `El token expiró hace ${Math.abs(Math.round(secondsLeft / 60))} min (venció ${expiresAt.toISOString()}). ` +
        'Los access tokens duran 1 hora: extrae uno nuevo del portal.'
    );

  return {
    tenant,
    expiresAt,
    secondsLeft,
    userCode: typeof p['iSAMS.ClientUserCode'] === 'string' ? (p['iSAMS.ClientUserCode'] as string) : null,
  };
}

/**
 * Claims crudos, sin validar nada y sin lanzar. `inspectToken` es la puerta que
 * decide si un token sirve; esto es para observar uno que quizá no sirve —el
 * journal (W6) y `auth status` (W9) tienen que poder describir un token vencido
 * en vez de reventar al mirarlo.
 */
export interface TokenClaims {
  tenant: string | null;
  /** Segundos epoch, tal como vienen. */
  exp: number | null;
  iat: number | null;
  /** Momento del login real. Con rotación silenciosa queda muy por detrás de `iat`. */
  authTime: number | null;
}

export function tokenClaims(token: string | undefined): TokenClaims {
  const empty: TokenClaims = { tenant: null, exp: null, iat: null, authTime: null };
  if (!token) return empty;
  let p: Record<string, unknown>;
  try {
    p = decodePayload(token);
  } catch {
    return empty;
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    tenant: String(p.iss ?? '').match(/^https:\/\/([^.]+)\.isams\.cloud/)?.[1] ?? null,
    exp: num(p.exp),
    iat: num(p.iat),
    authTime: num(p.auth_time),
  };
}

/** ISO 8601 desde segundos epoch, o null. Para escribir claims en el journal. */
export function isoFromEpoch(sec: number | null): string | null {
  return sec === null ? null : new Date(sec * 1000).toISOString();
}

/**
 * Tenant sin validar vigencia. Los refresh tokens son opacos (no JWT), así que
 * cuando solo hay refresh token el tenant tiene que venir del almacén o de
 * --tenant. Esto sirve para el caso en que hay un access token vencido.
 */
export function tenantOf(token: string | undefined): string | null {
  return tokenClaims(token).tenant;
}

// ── Renovación ───────────────────────────────────────────────────────────────

/**
 * Las tres formas en que puede terminar un intento de renovación (W4). La
 * distinción que importa es `dead` contra `indeterminate`: la primera es una
 * respuesta del servidor sobre el token, la segunda es la ausencia de respuesta.
 * Confundirlas hace que un corte de red se lea como una cadena rota, o peor, que
 * una rotación perdida se lea como un archivo sano.
 */
export type RefreshOutcome = 'ok' | 'dead' | 'indeterminate';

export interface RefreshResult {
  outcome: RefreshOutcome;
  /** Presentes solo si outcome === 'ok'. */
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  /** null cuando no llegó respuesta (error de red, timeout). */
  httpStatus: number | null;
  error: string | null;
  errorDescription: string | null;
  /** Primeros 200 caracteres del cuerpo crudo, para diagnosticar lo no previsto. */
  bodySnippet: string | null;
  /** Mensaje para el usuario. Vacío cuando outcome === 'ok'. */
  message: string;
}

const CHAIN_ROTA =
  'invalid_grant: el servidor ya no reconoce este refresh token. No es transitorio y no sirve ' +
  'reintentar: hace falta un bootstrap nuevo desde el navegador.';

/**
 * Renovación con refresh token. Opcional: solo hace falta para operación
 * desatendida.
 *
 * ❗ La rotación invalida el refresh token anterior. Quien llame a esto DEBE
 * persistir el nuevo de forma atómica antes de cualquier otra operación, o la
 * cadena se rompe y hace falta un bootstrap manual desde el navegador.
 *
 * No lanza: clasifica. Un fallo de red y un `invalid_grant` piden cosas
 * opuestas del que llama, así que la decisión no puede quedar escondida en un
 * throw genérico.
 */
export async function refreshAccessToken(
  tenant: string,
  refreshToken: string
): Promise<RefreshResult> {
  const scope = 'openid offline_access iSAMS.CloudPortals.Api iSAMS.Auth.ChangeAccountPassword.Invoke';

  let res: Response;
  try {
    res = await fetch(`https://${tenant}.isams.cloud/auth/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // Cliente público: no se envía client_secret. El scope completo es obligatorio.
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope,
        client_id: 'iSAMS.Portal.Cloud.Parents',
      }),
    });
  } catch (e) {
    // Sin respuesta: el servidor pudo haber rotado igual y la respuesta se perdió.
    return {
      outcome: 'indeterminate',
      httpStatus: null,
      error: 'network',
      errorDescription: (e as Error).message,
      bodySnippet: null,
      message:
        `No hubo respuesta del servidor de identidad (${(e as Error).message}). No se sabe si la ` +
        'renovación alcanzó a completarse: la cadena puede seguir viva o no.',
    };
  }

  const body = await res.text().catch(() => '');
  const snippet = body ? body.slice(0, 200) : null;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const str = (k: string) => (typeof parsed?.[k] === 'string' && parsed[k] ? (parsed[k] as string) : null);
  const error = str('error');
  const errorDescription = str('error_description');

  if (!res.ok) {
    // Solo `invalid_grant` es una afirmación del servidor sobre este token. El
    // resto —otros 4xx, 5xx— deja el estado de la cadena sin determinar.
    if (res.status === 400 && (error === 'invalid_grant' || (!parsed && body.includes('invalid_grant')))) {
      return {
        outcome: 'dead',
        httpStatus: res.status,
        error: 'invalid_grant',
        errorDescription,
        bodySnippet: snippet,
        message: errorDescription ? `${CHAIN_ROTA}\n  el servidor dijo: ${errorDescription}` : CHAIN_ROTA,
      };
    }
    return {
      outcome: 'indeterminate',
      httpStatus: res.status,
      error,
      errorDescription,
      bodySnippet: snippet,
      message:
        `La renovación falló con HTTP ${res.status}${error ? ` (${error})` : ''}` +
        `${errorDescription ? `: ${errorDescription}` : '.'} ` +
        'No es una respuesta sobre el token en sí: no se sabe si la cadena sigue viva.',
    };
  }

  const accessToken = str('access_token');
  const rotated = str('refresh_token');
  if (!parsed || !accessToken || !rotated) {
    // 2xx que no sirve. El servidor pudo haber rotado y nosotros no tenemos el nuevo.
    return {
      outcome: 'indeterminate',
      httpStatus: res.status,
      error: parsed ? 'incomplete_response' : 'unparseable_response',
      errorDescription: parsed
        ? `faltan ${[!accessToken && 'access_token', !rotated && 'refresh_token'].filter(Boolean).join(' y ')}`
        : null,
      bodySnippet: snippet,
      message:
        `El servidor respondió ${res.status} pero el cuerpo no trae un par de tokens utilizable. ` +
        'Puede haber rotado la cadena sin que hayamos recibido el token nuevo.',
    };
  }

  return {
    outcome: 'ok',
    accessToken,
    refreshToken: rotated,
    expiresIn: Number(parsed.expires_in ?? 3600),
    httpStatus: res.status,
    error: null,
    errorDescription: null,
    bodySnippet: null,
    message: '',
  };
}
