import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Almacén de credenciales.
 *
 * ❗ La rotación de refresh tokens (§2.7) define el contrato: cada renovación
 * devuelve un refresh token nuevo e invalida el anterior. Por eso el almacén
 * tiene que ser ESCRIBIBLE, no solo legible. Inyectar el refresh token como
 * valor inmutable —una variable de entorno fija, un secreto de solo lectura—
 * funciona exactamente una vez y después rompe la cadena.
 */

export interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  /** ISO 8601. Informativo: la verdad está en el `exp` del propio JWT. */
  expiresAt?: string;
  /** Necesario cuando solo queda el refresh token, que es opaco. */
  tenant?: string;
}

export interface TokenStore {
  readonly name: string;
  /** true si `save` persiste de verdad. Si es false, no se puede renovar. */
  readonly writable: boolean;
  load(): Promise<Credentials>;
  save(c: Credentials): Promise<void>;
}

export class StoreError extends Error {}

// ── Inline: lo que venga por flags o variables de entorno ────────────────────

/**
 * Solo lectura. Sirve para una corrida suelta con un access token recién sacado
 * del navegador. Si además se pasa un refresh token, se puede renovar UNA vez,
 * pero el token nuevo se pierde al terminar el proceso: la próxima corrida
 * fallará con invalid_grant. Para operación desatendida usa file o http.
 */
export class InlineStore implements TokenStore {
  readonly name = 'inline';
  readonly writable = false;
  constructor(private creds: Credentials) {}
  async load() {
    return this.creds;
  }
  async save(c: Credentials) {
    this.creds = c;
  }
}

// ── Archivo local ────────────────────────────────────────────────────────────

/** Escritura atómica: se escribe a un temporal y se renombra. Un corte a mitad
 *  deja el archivo anterior intacto en vez de uno truncado. */
export class FileStore implements TokenStore {
  readonly name: string;
  readonly writable = true;
  constructor(private path: string) {
    this.name = `archivo ${path}`;
  }
  async load(): Promise<Credentials> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Credentials;
    } catch (e) {
      throw new StoreError(`No se pudo leer ${this.path}: ${(e as Error).message}`);
    }
  }
  async save(c: Credentials): Promise<void> {
    const tmp = join(dirname(this.path), `.${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

// ── Endpoint REST genérico ───────────────────────────────────────────────────

export interface HttpStoreOptions {
  url: string;
  apiKey?: string;
  /**
   * Cabecera de autenticación. Si es `Authorization` (por defecto) se envía
   * `Bearer <apiKey>`; con cualquier otro nombre se envía la clave cruda.
   */
  header?: string;
}

/**
 * GET para leer, POST para guardar. Cuerpo JSON:
 *
 *   { "accessToken": "...", "refreshToken": "...", "expiresAt": "ISO" }
 *
 * Como la firma real del endpoint todavía no está definida, en la lectura se
 * aceptan también las variantes snake_case (`access_token`, `refresh_token`)
 * y un envoltorio `{ data: {...} }`, que es lo más común. Si tu endpoint usa
 * otro contrato, esto es lo único que hay que ajustar.
 */
export class HttpStore implements TokenStore {
  readonly name: string;
  readonly writable = true;
  private headers: Record<string, string>;

  constructor(private opts: HttpStoreOptions) {
    this.name = `endpoint ${opts.url}`;
    this.headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (opts.apiKey) {
      const h = opts.header ?? 'Authorization';
      this.headers[h] = h.toLowerCase() === 'authorization' ? `Bearer ${opts.apiKey}` : opts.apiKey;
    }
  }

  async load(): Promise<Credentials> {
    let res: Response;
    try {
      res = await fetch(this.opts.url, { method: 'GET', headers: this.headers });
    } catch (e) {
      throw new StoreError(`No se pudo contactar ${this.opts.url}: ${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403)
      throw new StoreError(`${res.status} al leer el token: la API key fue rechazada.`);
    if (res.status === 404) return {};
    if (!res.ok) throw new StoreError(`${res.status} ${res.statusText} al leer el token.`);

    const raw = (await res.json()) as Record<string, unknown>;
    const d = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof d[k] === 'string' && d[k]) return d[k] as string;
      return undefined;
    };
    return {
      accessToken: pick('accessToken', 'access_token', 'token'),
      refreshToken: pick('refreshToken', 'refresh_token'),
      expiresAt: pick('expiresAt', 'expires_at'),
      tenant: pick('tenant'),
    };
  }

  async save(c: Credentials): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(c),
      });
    } catch (e) {
      throw new StoreError(`No se pudo guardar el token en ${this.opts.url}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Fallar acá es grave: el token viejo ya fue invalidado por el servidor
      // de identidad. Si no se persiste el nuevo, la cadena queda rota.
      throw new StoreError(
        `${res.status} al guardar el token renovado. La cadena de refresh puede haber quedado ` +
          `rota: guarda este refresh token a mano o rehaz el bootstrap. ${body.slice(0, 200)}`
      );
    }
  }
}
