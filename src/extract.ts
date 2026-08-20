import type { RawExtract, RawColumn, RawMarkbook, RawStudent } from './types.js';

/**
 * Etapa 1: API iSAMS -> RawExtract.
 *
 * Agnóstico del colegio (§1–9 de la referencia). No interpreta nada: no
 * convierte notas, no detecta modelos, no calcula promedios. Solo trae datos y
 * les quita la PII.
 */

export interface ExtractOptions {
  tenant: string;
  accessToken: string;
  /**
   * Lista opaca separada por comas que identifica la vista del apoderado.
   * No se deriva de ningún claim del token: se obtiene mirando la petición que
   * hace el portal en la pestaña Network durante el bootstrap.
   */
  parentsPath: string;
  /** Pausa entre llamadas. La API de un colegio no está hecha para polling. */
  delayMs?: number;
  /** Override del host. Por defecto https://{tenant}.isams.cloud/api/portals. */
  baseUrl?: string;
  /** Detalle paso a paso. Solo se muestra con --verbose. */
  onProgress?: (msg: string) => void;
  /**
   * Un titular por estudiante, al empezar con él. Se muestra siempre: es lo
   * único que explica por qué el proceso está tardando —son ~26 peticiones
   * secuenciales y sin esto la terminal se queda muda medio minuto.
   */
  onStudent?: (nombre: string) => void;
}

export class ExtractError extends Error {}

/** Los únicos 6 campos que se conservan del endpoint de estudiantes. */
const KEEP = ['schoolId', 'fullName', 'preferredName', 'formGroup', 'yearGroup', 'schoolCode', 'familyId'] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function extract(opts: ExtractOptions): Promise<RawExtract> {
  const { tenant, accessToken, parentsPath } = opts;
  const delay = opts.delayMs ?? 300;
  const log = opts.onProgress ?? (() => {});
  const titular = opts.onStudent ?? (() => {});
  const base = opts.baseUrl ?? `https://${tenant}.isams.cloud/api/portals`;

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(base + path, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        // Sin User-Agent el borde de Cloudflare responde 403.
        'User-Agent': 'isams-boletin/1.0',
      },
    });
    if (res.status === 401) throw new ExtractError('401: el access token venció o no es válido. Vida útil: 1 hora.');
    if (res.status === 403) throw new ExtractError(`403 en ${path}. Revisa el parentsPath y que la cuenta tenga acceso.`);
    if (!res.ok) throw new ExtractError(`HTTP ${res.status} en ${path}.`);
    return (await res.json()) as T;
  }

  // ── 1. Estudiantes ─────────────────────────────────────────────────────────
  // La respuesta trae ~59 campos por estudiante; 53 son datos personales de
  // menores (domicilio, fecha de nacimiento, correo escolar, religión, etnia,
  // discapacidades, foto). Se descartan ACÁ, antes de que nada toque disco.
  log('Listando estudiantes…');
  const raw = await get<{ students: Record<string, unknown>[] }>(
    `/students/portal/parents/${encodeURI(parentsPath)}`
  );
  if (!raw?.students?.length)
    throw new ExtractError('El endpoint de estudiantes no devolvió ninguno. Verifica el parentsPath.');

  const minimal = raw.students.map((s) => {
    const o: Record<string, unknown> = {};
    for (const k of KEEP) o[k] = s[k];
    return o;
  });

  const students: RawStudent[] = [];
  for (const [i, s] of minimal.entries()) {
    // schoolId equivale a un identificador nacional de un menor. Se usa para
    // pedir los markbooks y NO se copia al RawExtract.
    const schoolId = String(s.schoolId ?? '');
    if (!schoolId) throw new ExtractError('Un estudiante vino sin schoolId; no se puede consultar su libro.');
    const displayName = String(s.fullName ?? s.preferredName ?? `Estudiante ${i + 1}`);

    // Nombre de pila: alcanza para saber por quién va, y expone menos que el
    // nombre completo en una terminal o en un log de tarea programada.
    titular(String(s.preferredName ?? displayName.split(' ')[0]));

    // ── 2. Markbooks ────────────────────────────────────────────────────────
    // Los id no son predecibles: hay que enumerarlos, nunca generarlos.
    log(`${displayName}: listando libros…`);
    const books = await get<{ id: number; name: string; description: string | null }[]>(
      `/markbooks/students/${encodeURIComponent(schoolId)}`
    );
    await sleep(delay);

    const markbooks: RawMarkbook[] = [];
    for (const b of books) {
      // ── 3. Columnas ───────────────────────────────────────────────────────
      const cols = await get<Record<string, unknown>[]>(
        `/markbooks/${b.id}/students/${encodeURIComponent(schoolId)}/columns`
      );
      markbooks.push({
        id: b.id,
        name: b.name,
        description: b.description ?? null,
        columns: cols.map(normalizeColumn),
      });
      await sleep(delay);
    }
    log(`${displayName}: ${markbooks.length} libros, ${markbooks.reduce((n, m) => n + m.columns.length, 0)} columnas.`);

    students.push({ key: `s${i + 1}`, displayName, formGroup: String(s.formGroup ?? ''), markbooks });
  }

  return {
    schemaVersion: '1.0',
    tenant,
    extractedAt: new Date().toISOString(),
    students,
  };
}

/**
 * Se normaliza defensivamente: seis de estos campos vinieron vacíos en el 100%
 * de lo observado, pero podrían poblarse en otra instalación y un consumidor no
 * debería romperse ni depender de ellos.
 */
function normalizeColumn(c: Record<string, unknown>): RawColumn {
  return {
    id: Number(c.id),
    name: String(c.name ?? ''),
    type: c.type === 'Calculation' ? 'Calculation' : 'Assessment',
    value: c.value == null ? null : String(c.value),
    parentGroupings: Array.isArray(c.parentGroupings)
      ? (c.parentGroupings as Record<string, unknown>[]).map((g) => ({ name: String(g.name ?? '') }))
      : [],
    absent: c.absent === true,
    hasComments: c.hasComments === true,
    assessmentDate: c.assessmentDate == null ? null : String(c.assessmentDate),
    outOf: c.outOf == null ? null : Number(c.outOf),
  };
}
