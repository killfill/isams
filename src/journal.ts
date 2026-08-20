/**
 * Bitácora de la cadena de refresh (W6).
 *
 * JSONL append-only, una línea por interacción con el endpoint de tokens. Existe
 * porque la causa de un `invalid_grant` no es reconstruible después: para cuando
 * el fallo aparece, el estado que lo explica ya fue sobrescrito. Esto graba los
 * hechos en el momento en que ocurren.
 *
 * ❗ Nunca escribe un token completo. Solo colas de 6 caracteres.
 *
 * Escribir acá jamás puede voltear una corrida: todo va envuelto en try/catch y
 * un fallo se avisa por stderr y se sigue. Una bitácora perdida es barata; una
 * extracción perdida por no poder anotarla, no.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { isoFromEpoch, type RefreshOutcome, type TokenClaims } from './auth.js';

export type JournalEvent = 'bootstrap' | 'refresh' | 'reuse';
export type Trigger = 'manual' | 'scheduled';

export interface JournalEntry {
  ts: string;
  event: JournalEvent;
  outcome: RefreshOutcome | null;
  tenant: string | null;
  runId: string;
  trigger: Trigger;
  oldRtTail: string | null;
  newRtTail: string | null;
  httpStatus: number | null;
  error: string | null;
  errorDescription: string | null;
  bodySnippet: string | null;
  accessTokenExp: string | null;
  accessTokenIat: string | null;
  authTime: string | null;
  /** Segundos desde `auth_time`. Acumulado, mide la vida real de la cadena. */
  chainAgeSec: number | null;
}

/** Lo que el llamador aporta; el resto lo completa el journal. */
export interface JournalInput {
  event: JournalEvent;
  outcome?: RefreshOutcome | null;
  tenant?: string | null;
  oldRtTail?: string | null;
  newRtTail?: string | null;
  httpStatus?: number | null;
  error?: string | null;
  errorDescription?: string | null;
  bodySnippet?: string | null;
  claims?: TokenClaims;
}

/** El archivo se sincroniza a la KB como documento: tiene que quedarse chico. */
const MAX_LINES = 200;

/** Últimos 6 caracteres. Suficiente para correlacionar, inútil para autenticarse. */
export function tail(token: string | undefined | null): string | null {
  if (!token) return null;
  return token.length <= 6 ? token : token.slice(-6);
}

/**
 * Un 2xx incompleto trae el cuerpo con un access_token dentro. Recortar a 200
 * caracteres no basta: hay que borrar el valor antes de guardarlo.
 */
export function redactSnippet(body: string | null | undefined): string | null {
  if (!body) return null;
  const clean = body.replace(
    /("(?:access_token|refresh_token|id_token)"\s*:\s*")([^"]*)(")/g,
    (_m, a: string, v: string, z: string) => `${a}…${tail(v) ?? ''}${z}`
  );
  return clean.slice(0, 200);
}

/** Hermano del archivo de credenciales: cred.json -> cred.journal.jsonl */
export function defaultJournalPath(credentialsPath: string): string {
  const abs = resolve(credentialsPath);
  const ext = extname(abs);
  return join(dirname(abs), `${basename(abs, ext)}.journal.jsonl`);
}

export class Journal {
  readonly path: string;
  constructor(
    path: string,
    private runId: string,
    private trigger: Trigger,
    private warn: (m: string) => void = (m) => console.error(m)
  ) {
    this.path = resolve(path);
  }

  append(input: JournalInput): void {
    try {
      const c = input.claims;
      const authTime = c?.authTime ?? null;
      const entry: JournalEntry = {
        ts: new Date().toISOString(),
        event: input.event,
        outcome: input.outcome ?? null,
        tenant: input.tenant ?? c?.tenant ?? null,
        runId: this.runId,
        trigger: this.trigger,
        oldRtTail: input.oldRtTail ?? null,
        newRtTail: input.newRtTail ?? null,
        httpStatus: input.httpStatus ?? null,
        error: input.error ?? null,
        errorDescription: input.errorDescription ?? null,
        bodySnippet: redactSnippet(input.bodySnippet),
        accessTokenExp: isoFromEpoch(c?.exp ?? null),
        accessTokenIat: isoFromEpoch(c?.iat ?? null),
        authTime: isoFromEpoch(authTime),
        chainAgeSec: authTime === null ? null : Math.round(Date.now() / 1000 - authTime),
      };
      mkdirSync(dirname(this.path), { recursive: true });
      if (!existsSync(this.path)) writeFileSync(this.path, '', { mode: 0o600 });
      appendFileSync(this.path, JSON.stringify(entry) + '\n');
      this.rotate();
    } catch (e) {
      this.warn(`aviso: no se pudo anotar en la bitácora ${this.path}: ${(e as Error).message}`);
    }
  }

  /** Deja solo las últimas MAX_LINES. Se llama después de cada append. */
  private rotate(): void {
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    writeFileSync(this.path, lines.slice(-MAX_LINES).join('\n') + '\n', { mode: 0o600 });
  }

  /** Entradas legibles. Las líneas corruptas se saltan en vez de reventar. */
  read(): JournalEntry[] {
    try {
      if (!existsSync(this.path)) return [];
      const out: JournalEntry[] = [];
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as JournalEntry);
        } catch {
          // línea a medio escribir: se ignora
        }
      }
      return out;
    } catch (e) {
      this.warn(`aviso: no se pudo leer la bitácora ${this.path}: ${(e as Error).message}`);
      return [];
    }
  }

  /** Colas de refresh token ya vistas. Sirve para detectar un bootstrap nuevo. */
  knownTails(): Set<string> {
    const s = new Set<string>();
    for (const e of this.read()) {
      if (e.oldRtTail) s.add(e.oldRtTail);
      if (e.newRtTail) s.add(e.newRtTail);
    }
    return s;
  }
}
