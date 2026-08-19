/**
 * Genera access tokens de prueba (firma falsa: el código no la verifica).
 * Sirve como módulo importable y como script: `tsx test/maketoken.ts`.
 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export interface FakeTokenOptions {
  tenant?: string;
  expiresInSec?: number;
  audience?: string[];
  scope?: string[];
  issuer?: string;
}

export function makeToken(o: FakeTokenOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const tenant = o.tenant ?? 'britishroyal';
  return [
    b64({ alg: 'RS256', typ: 'at+jwt' }),
    b64({
      iss: o.issuer ?? `https://${tenant}.isams.cloud/auth`,
      iat: now,
      exp: now + (o.expiresInSec ?? 3600),
      aud: o.audience ?? ['REST API', 'Authentication Server'],
      scope: o.scope ?? ['openid', 'iSAMS.CloudPortals.Api', 'iSAMS.Auth.ChangeAccountPassword.Invoke', 'offline_access'],
      'iSAMS.ClientUserCode': 'TEST',
    }),
    'firmafalsa',
  ].join('.');
}

// Ejecutado directamente: imprime un token válido por una hora.
if (import.meta.url === `file://${process.argv[1]}`) console.log(makeToken());
