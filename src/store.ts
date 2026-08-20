import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Almacén de credenciales.
 *
 * ❗ La rotación de refresh tokens define el contrato: cada renovación devuelve
 * un refresh token nuevo e invalida el anterior. Por eso el almacén tiene que
 * ser ESCRIBIBLE, no solo legible. Inyectar el refresh token como valor
 * inmutable —una variable de entorno fija, un secreto de solo lectura— funciona
 * exactamente una vez y después rompe la cadena.
 */

export interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  /** ISO 8601. Informativo: la verdad está en el `exp` del propio JWT. */
  expiresAt?: string;
  /** Necesario cuando solo queda el refresh token, que es opaco. */
  tenant?: string;
  /**
   * La corrida anterior no supo si su renovación se completó. Lo pone un
   * resultado `indeterminate` y lo limpia el siguiente `ok`. Mientras esté, el
   * refresh token del archivo puede estar vivo o muerto y no hay forma local de
   * saberlo.
   */
  suspect?: boolean;
  /**
   * Cola de 6 caracteres del refresh token anterior —nunca el token entero—,
   * para que una rotación sospechosa se pueda diagnosticar mirando el archivo.
   */
  refreshTokenPrevious?: string;
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
 * fallará con invalid_grant. Para operación desatendida usa --token-file.
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

/** Discrimina temporales de procesos simultáneos: dos corridas en el mismo
 *  milisegundo compartían nombre y se pisaban el archivo a medio escribir. */
let seq = 0;

/**
 * Escritura atómica: se escribe a un temporal y se renombra. Un corte a mitad
 * deja el archivo anterior intacto en vez de uno truncado.
 *
 * La ruta se resuelve a absoluta al construir: es la que se usa para escribir,
 * para nombrar la bitácora y para todos los mensajes, así que un error nunca
 * habla de una ruta relativa cuyo cwd el lector tiene que adivinar.
 */
export class FileStore implements TokenStore {
  readonly name: string;
  readonly path: string;
  readonly writable = true;
  constructor(path: string) {
    this.path = resolve(path);
    this.name = `archivo ${this.path}`;
  }
  async load(): Promise<Credentials> {
    // Un directorio inexistente tampoco es error al leer: se crea al guardar.
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Credentials;
    } catch (e) {
      throw new StoreError(`No se pudo leer ${this.path}: ${(e as Error).message}`);
    }
  }
  async save(c: Credentials): Promise<void> {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${process.pid}-${++seq}.tmp`);
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
