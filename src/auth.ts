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
 * Tenant sin validar vigencia. Los refresh tokens son opacos (no JWT), así que
 * cuando solo hay refresh token el tenant tiene que venir del almacén o de
 * --tenant. Esto sirve para el caso en que hay un access token vencido.
 */
export function tenantOf(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const p = decodePayload(token);
    const m = String(p.iss ?? '').match(/^https:\/\/([^.]+)\.isams\.cloud/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Renovación con refresh token (§2.5). Opcional: solo hace falta para operación
 * desatendida.
 *
 * ❗ La rotación invalida el refresh token anterior. Quien llame a esto DEBE
 * persistir el nuevo de forma atómica antes de cualquier otra operación, o la
 * cadena se rompe y hace falta un bootstrap manual desde el navegador.
 */
export async function refreshAccessToken(
  tenant: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const scope = 'openid offline_access iSAMS.CloudPortals.Api iSAMS.Auth.ChangeAccountPassword.Invoke';
  const res = await fetch(`https://${tenant}.isams.cloud/auth/connect/token`, {
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

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 400 && body.includes('invalid_grant'))
      throw new TokenError(
        'invalid_grant: la cadena de refresh está rota (token ya usado, revocado, o hay otra sesión compitiendo). ' +
          'No es transitorio: no reintentar, hace falta un bootstrap nuevo desde el navegador.'
      );
    throw new TokenError(`La renovación falló con HTTP ${res.status}. ${body.slice(0, 200)}`);
  }

  const j = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: String(j.access_token),
    refreshToken: String(j.refresh_token),
    expiresIn: Number(j.expires_in ?? 3600),
  };
}
