/**
 * CONTRATOS DEL PIPELINE
 *
 *   API iSAMS ──[extract]──> RawExtract ──[interpret]──> ReportModel ──[render]──> HTML
 *                             ^^^^^^^^^^                  ^^^^^^^^^^^
 *                             sin PII                     congelado y versionado
 *
 * Las dos fronteras son JSON serializable. Cada etapa es una función pura de la
 * anterior, así que se puede reejecutar, cachear, diffear y testear por separado.
 */

// ─────────────────────────── Frontera 1: RawExtract ───────────────────────────
// Refleja la API tal cual, MENOS los ~53 campos de PII (Anexo C). El extractor
// traduce schoolId -> key opaca y descarta el schoolId: nunca entra al pipeline.

export interface RawExtract {
  schemaVersion: '1.0';
  tenant: string;
  /** ISO 8601. Único eje temporal disponible: la API no expone assessmentDate. */
  extractedAt: string;
  students: RawStudent[];
}

export interface RawStudent {
  /** Identificador local estable. NO es schoolId (equivale a un RUT de menor). */
  key: string;
  displayName: string;
  formGroup: string;
  markbooks: RawMarkbook[];
}

export interface RawMarkbook {
  id: number;
  name: string;
  description: string | null;
  columns: RawColumn[];
}

export interface RawColumn {
  id: number;
  name: string;
  type: 'Assessment' | 'Calculation';
  value: string | null;
  parentGroupings: { name: string }[];
  absent: boolean | null;
  hasComments: boolean | null;
  assessmentDate: string | null;
  outOf: number | null;
}

// ─────────────────────────── Frontera 2: ReportModel ──────────────────────────
// Todo lo que el informe necesita, ya interpretado. El renderer no calcula nada:
// si un número no está acá, no aparece en el HTML.

export type CalcModel = 'simple' | 'weighted' | 'twoStep';

export type AverageSource =
  | 'published' // el valor que publica la plataforma, usado tal cual
  | 'recalculated' // la plataforma lo distorsionó; renormalizado (§10.4.1)
  | 'estimated' // aún no publicado; calculado con las notas presentes
  | 'qualitative' // escala conceptual, no numérica
  | 'none';

export interface Average {
  value: number | null;
  source: AverageSource;
  /** Lo que publica la plataforma. Se conserva siempre, incluso al corregirlo. */
  published: number | null;
  /** Solo si source==='recalculated': % de peso sin notas que causó la distorsión. */
  missingWeightPct: number | null;
  /** Solo si source==='qualitative': el texto tal cual ("MB"). */
  text: string | null;
}

export interface Cell {
  /** Etiqueta opaca de la API. Para mostrar, nunca para lógica (§5). */
  label: string;
  /** Nombre del bloque, opaco. null si la evaluación cuelga directo del periodo. */
  block: string | null;
  weightPct: number | null;
  /** Fila Calculation dentro de un bloque: promedio materializado, no una nota. */
  derived: boolean;
  /** Pertenece al bloque que más influye en el promedio. Dirige el fondo gris. */
  heavier: boolean;
  value: number | null;
  rawValue: string | null;
  /** Valor no numérico ("MB"). Excluido de todo promedio numérico. */
  qualitative: string | null;
  absent: boolean;
  hasComments: boolean;
}

export interface Period {
  /** Opaco: "Semestre 1", "PROMEDIOS 2026"… No parsear. */
  label: string;
  model: CalcModel;
  cells: Cell[];
  average: Average;
}

export interface Subject {
  name: string;
  /** markbook.name crudo, por si hace falta rastrear el origen. */
  sourceLabel: string;
  model: CalcModel;
  qualitative: boolean;
  periods: Period[];
  final: Average;
}

export interface Student {
  key: string;
  displayName: string;
  formGroup: string;
  subjects: Subject[];
  /** Media simple de los finales numéricos. Excluye asignaturas cualitativas. */
  overall: number | null;
  overallBasis: number;
  /** Etiquetas de periodo en orden de aparición: define las columnas del render. */
  periodLabels: string[];
  /** Máximo de celdas por periodo: define cuántas columnas dibuja el render. */
  cellsPerPeriod: Record<string, number>;
}

export type WarningCode =
  | 'DISTORTION_CORRECTED' // esperada: bloque con peso sin notas
  | 'MODEL_MISMATCH' // ❗ el modelo detectado no reproduce el valor publicado
  | 'NO_PUBLISHED_AVERAGE' // periodo en curso: se estimó
  | 'QUALITATIVE_SUBJECT'
  | 'AGGREGATOR_INCOMPLETE' // el markbook agregador no cubre todas las asignaturas
  | 'UNEXPECTED_FIELD'; // un campo documentado como vacío vino poblado

export interface Warning {
  code: WarningCode;
  severity: 'info' | 'warn' | 'error';
  student: string;
  subject?: string;
  period?: string;
  message: string;
}

export interface ReportModel {
  schemaVersion: '1.0';
  tenant: string;
  profileId: string;
  extractedAt: string;
  renderedAt: string;
  students: Student[];
  warnings: Warning[];
  /** Resultado del control de calidad. Ver verify.ts. */
  verification: {
    periodsChecked: number;
    reproduced: number;
    corrected: number;
    estimated: number;
    mismatches: number;
  };
}

// ──────────────────────────── Perfil del colegio ──────────────────────────────
// Todo lo específico de una instalación vive acá. Portar a otro colegio =
// escribir un perfil nuevo, no tocar código.

export interface SchoolProfile {
  id: string;
  scale: {
    min: number;
    max: number;
    pass: number;
    /**
     * value llega en dos formatos en el mismo campo: "51" (centésimas) y "3.8".
     * Se divide por 10 lo que supere este umbral. Seguro porque una nota válida
     * nunca supera max, y la forma en centésimas siempre es >= 10 (§10.1).
     */
    centesimalAbove: number;
  };
  /** Prefijo del description del markbook agregador. Coincidencia por prefijo. */
  aggregatorPrefix: string;
  /** Subcadena que identifica una columna de promedio. Comparación tolerante. */
  averageNameHint: string;
  /** Etiquetas de lectura por modelo. Los nombres técnicos no se muestran. */
  modelLabels: Record<CalcModel, { label: string; description: string }>;
  strings: {
    title: string;
    heavierBlockNote: string;
    distortionNote: string;
  };
}
