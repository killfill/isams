import type {
  Average,
  CalcModel,
  Cell,
  Period,
  RawColumn,
  RawExtract,
  RawMarkbook,
  RawStudent,
  ReportModel,
  SchoolProfile,
  Student,
  Subject,
  Warning,
} from './types.js';

const WEIGHT_RE = /(\d{1,3})\s*%/;
/** Tolerancia al comparar contra un valor publicado con 1 decimal. */
const EPS = 0.06;

const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * §10.1 — La conversión se apoya en el RANGO, no en el tipo ni en la presencia
 * de punto decimal. Un valor sobre el máximo de la escala solo puede ser la
 * representación en centésimas, así que no hay solapamiento.
 */
export function toGrade(
  raw: string | null,
  p: SchoolProfile
): { value: number | null; qualitative: string | null } {
  if (raw === null || raw.trim() === '') return { value: null, qualitative: null };
  const n = Number(raw);
  // §10.2 — Number("MB") es NaN. Validar ANTES de convertir o el NaN se propaga
  // a todo promedio que incluya la asignatura.
  if (!Number.isFinite(n)) return { value: null, qualitative: raw };
  return { value: r2(n > p.scale.centesimalAbove ? n / 10 : n), qualitative: null };
}

const blockOf = (c: RawColumn) => c.parentGroupings[1]?.name ?? null;
const periodOf = (c: RawColumn) => c.parentGroupings[0]?.name ?? null;
const weightOf = (block: string | null) => {
  const m = block?.match(WEIGHT_RE);
  return m ? Number(m[1]) : null;
};

/** Coincidencia tolerante: los nombres de promedio tienen 13+ variantes (§5). */
const isAverageColumn = (c: RawColumn, p: SchoolProfile) =>
  c.type === 'Calculation' &&
  c.name.toLowerCase().includes(p.averageNameHint.toLowerCase());

/**
 * §10.3.4 — El modelo se infiere de la FORMA de los bloques. No existe ningún
 * campo que lo declare, y condicionar por yearGroup da resultados equivocados
 * porque los modelos coexisten dentro de un mismo nivel.
 */
function detectModel(blocks: Map<string | null, RawColumn[]>): CalcModel {
  const named = [...blocks.keys()].filter((b) => b !== null) as string[];
  if (named.length === 0) return 'simple';
  if (named.some((b) => WEIGHT_RE.test(b))) return 'weighted';
  return 'twoStep';
}

/**
 * El bloque que más influye por nota. Dirige el fondo gris del informe.
 *  - weighted: el del porcentaje mayoritario.
 *  - twoStep:  el terminal, identificado por contener la fila Calculation
 *              derivada; si no la hay, el último por orden de aparición.
 * Con un solo bloque no se destaca nada: no habría nada de qué distinguirlo.
 */
function heavierBlock(
  blocks: Map<string | null, RawColumn[]>,
  model: CalcModel
): string | null {
  if (blocks.size < 2) return null;
  if (model === 'weighted') {
    let best: string | null = null;
    let bestW = 0;
    for (const b of blocks.keys()) {
      const w = weightOf(b);
      if (w !== null && w > bestW) [best, bestW] = [b, w];
    }
    return bestW >= 50 ? best : null;
  }
  if (model === 'twoStep') return terminalBlock(blocks);
  return null;
}

/**
 * El bloque terminal: donde vive el promedio del periodo. Se identifica por
 * contener la fila Calculation derivada; si no la hay, es el último por orden.
 * A diferencia de heavierBlock, siempre devuelve un bloque —aunque sea el
 * único—, porque el cálculo lo necesita para promediar.
 */
function terminalBlock(blocks: Map<string | null, RawColumn[]>): string | null {
  const withDerived = [...blocks.entries()].filter(([, cs]) =>
    cs.some((c) => c.type === 'Calculation')
  );
  if (withDerived.length) return withDerived[withDerived.length - 1][0];
  const keys = [...blocks.keys()];
  return keys.length ? keys[keys.length - 1] : null;
}

/**
 * Reproduce el cálculo TAL COMO LO HACE LA PLATAFORMA, distorsión incluida.
 * No sirve para publicar un número: sirve para verificar que el modelo se
 * detectó bien, comparando contra el promedio que la plataforma sí publicó.
 */
function structuralAverage(
  blocks: Map<string | null, RawColumn[]>,
  model: CalcModel,
  p: SchoolProfile
): number | null {
  const val = (c: RawColumn) => toGrade(c.value, p).value;

  if (model === 'simple') {
    const vs = [...blocks.values()].flat().filter((c) => c.type === 'Assessment').map(val)
      .filter((v): v is number => v !== null);
    return vs.length ? r2(mean(vs)) : null;
  }

  if (model === 'weighted') {
    let acc = 0;
    let any = false;
    for (const [b, cs] of blocks) {
      const w = weightOf(b);
      if (w === null) continue;
      any = true;
      const vs = cs.filter((c) => c.type === 'Assessment').map(val)
        .filter((v): v is number => v !== null);
      // Un bloque sin notas aporta 0 — esta es exactamente la distorsión de
      // §10.4.1, y reproducirla es lo que valida la detección.
      acc += vs.length ? mean(vs) * (w / 100) : 0;
    }
    return any ? r2(acc) : null;
  }

  // twoStep: media simple del bloque terminal, INCLUYENDO la fila Calculation.
  // Promediar solo las Assessment da un resultado incorrecto (§10.3.2).
  const terminal = terminalBlock(blocks);
  const vs = (blocks.get(terminal) ?? []).map(val).filter((v): v is number => v !== null);
  return vs.length ? r2(mean(vs)) : null;
}

/** §10.4.1 — Corrección: excluir bloques sin notas y renormalizar los pesos. */
function renormalized(
  blocks: Map<string | null, RawColumn[]>,
  p: SchoolProfile
): { value: number; missingPct: number } | null {
  const present = new Map<string, number>();
  for (const [b, cs] of blocks) {
    const w = weightOf(b);
    if (w === null) continue;
    const vs = cs.filter((c) => c.type === 'Assessment').map((c) => toGrade(c.value, p).value)
      .filter((v): v is number => v !== null);
    if (vs.length) present.set(b as string, w);
  }
  if (!present.size) return null;
  const sum = [...present.values()].reduce((a, b) => a + b, 0);
  // Dos casos, ambos necesarios: el bloque existe pero sin notas, y el bloque
  // aún no existe como columna. El segundo solo se detecta por Σ pesos < 100.
  if (sum >= 99.5) return null;
  let acc = 0;
  for (const [b, w] of present) {
    const vs = (blocks.get(b) ?? []).filter((c) => c.type === 'Assessment')
      .map((c) => toGrade(c.value, p).value).filter((v): v is number => v !== null);
    acc += mean(vs) * w;
  }
  return { value: r2(acc / sum), missingPct: Math.round(100 - sum) };
}

// ─────────────────────────────────────────────────────────────────────────────

function buildPeriod(
  label: string,
  columns: RawColumn[],
  p: SchoolProfile,
  push: (w: Omit<Warning, 'student'>) => void,
  subjectName: string
): Period {
  // Orden de servidor preservado: refleja cómo el profesor armó el libro.
  const blocks = new Map<string | null, RawColumn[]>();
  for (const c of columns) {
    if (c.parentGroupings.length <= 1) continue; // promedios del periodo
    const b = blockOf(c);
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b)!.push(c);
  }
  // Modelo simple: las evaluaciones cuelgan directo del periodo.
  if (blocks.size === 0) {
    const direct = columns.filter((c) => c.type === 'Assessment');
    if (direct.length) blocks.set(null, direct);
  }

  const model = detectModel(blocks);
  const heavy = heavierBlock(blocks, model);

  const cells: Cell[] = [];
  for (const [b, cs] of blocks) {
    for (const c of cs) {
      const g = toGrade(c.value, p);
      cells.push({
        label: c.name,
        block: b,
        weightPct: weightOf(b),
        derived: c.type === 'Calculation',
        heavier: b !== null && b === heavy,
        value: g.value,
        rawValue: c.value,
        qualitative: g.qualitative,
        absent: c.absent === true,
        hasComments: c.hasComments === true,
      });
    }
  }

  // Promedio publicado del periodo: profundidad <= 1 (§4.3.2).
  const pubCol =
    columns.filter((c) => isAverageColumn(c, p) && c.parentGroupings.length <= 1).pop() ??
    columns.filter((c) => isAverageColumn(c, p)).pop() ??
    null;
  const pub = pubCol ? toGrade(pubCol.value, p) : null;

  let average: Average;
  const fix = model === 'weighted' ? renormalized(blocks, p) : null;

  if (pub?.qualitative) {
    average = { value: null, source: 'qualitative', published: null, missingWeightPct: null, text: pub.qualitative };
  } else if (fix) {
    average = { value: fix.value, source: 'recalculated', published: pub?.value ?? null, missingWeightPct: fix.missingPct, text: null };
    push({
      code: 'DISTORTION_CORRECTED', severity: 'warn', subject: subjectName, period: label,
      message: `Promedio publicado ${pub?.value ?? '—'} distorsionado por ${fix.missingPct}% de peso sin notas; corregido a ${fix.value}.`,
    });
  } else if (pub?.value !== null && pub?.value !== undefined) {
    average = { value: pub.value, source: 'published', published: pub.value, missingWeightPct: null, text: null };
  } else {
    // §10.4: si la plataforma aún no publicó, estimar con el modelo detectado.
    const est = structuralAverage(blocks, model, p);
    average = { value: est, source: est === null ? 'none' : 'estimated', published: null, missingWeightPct: null, text: null };
    if (est !== null)
      push({
        code: 'NO_PUBLISHED_AVERAGE', severity: 'info', subject: subjectName, period: label,
        message: `La plataforma no publica promedio para ${label}; estimado en ${est}.`,
      });
  }

  // Control de calidad: ¿el modelo detectado reproduce lo que publica la
  // plataforma? Si no, la detección falló y el número no es confiable.
  if (average.source === 'published' && average.published !== null) {
    const structural = structuralAverage(blocks, model, p);
    if (structural !== null && Math.abs(structural - average.published) > EPS)
      push({
        code: 'MODEL_MISMATCH', severity: 'error', subject: subjectName, period: label,
        message: `El modelo "${model}" da ${structural} pero la plataforma publica ${average.published}. La detección puede estar equivocada.`,
      });
  }

  return { label, model, cells, average };
}

function buildSubject(
  mb: RawMarkbook,
  p: SchoolProfile,
  push: (w: Omit<Warning, 'student'>) => void
): Subject {
  const byPeriod = new Map<string, RawColumn[]>();
  const globals: RawColumn[] = [];
  for (const c of mb.columns) {
    const per = periodOf(c);
    if (per === null) globals.push(c);
    else {
      if (!byPeriod.has(per)) byPeriod.set(per, []);
      byPeriod.get(per)!.push(c);
    }
  }

  const name = cleanSubjectName(mb.name);
  const periods = [...byPeriod.entries()].map(([label, cs]) =>
    buildPeriod(label, cs, p, push, name)
  );

  // Promedio final publicado: parentGroupings vacío.
  const finalCol = globals.filter((c) => isAverageColumn(c, p)).pop() ?? null;
  const finalPub = finalCol ? toGrade(finalCol.value, p) : null;

  const qualitative =
    periods.some((x) => x.average.source === 'qualitative') || !!finalPub?.qualitative;
  const adjusted = periods.some(
    (x) => x.average.source === 'recalculated' || x.average.source === 'estimated'
  );
  const vals = periods.map((x) => x.average.value).filter((v): v is number => v !== null);
  // §10.3.5 — media simple de los promedios de periodo, sin ponderar.
  const computed = vals.length ? r2(mean(vals)) : null;

  let final: Average;
  if (qualitative && computed === null) {
    final = { value: null, source: 'qualitative', published: null, missingWeightPct: null, text: finalPub?.qualitative ?? null };
  } else if (adjusted || finalPub?.value == null) {
    final = {
      value: computed,
      source: adjusted ? 'recalculated' : 'published',
      published: finalPub?.value ?? null, missingWeightPct: null, text: null,
    };
  } else {
    // §10.4 — sin distorsión detectada, se confía en el valor publicado.
    final = { value: finalPub.value, source: 'published', published: finalPub.value, missingWeightPct: null, text: null };
  }

  const model = periods[0]?.model ?? 'simple';
  return { name, sourceLabel: mb.name, model, qualitative, periods, final };
}

/** Quita prefijo de curso y año del markbook.name. Solo para mostrar (§4.2). */
function cleanSubjectName(raw: string): string {
  return (
    raw.replace(/\s*20\d\d\s*$/, '').replace(/^\s*[A-Z0-9]{1,3}-?[A-Z]?\s*[-–]?\s*/, '').trim() ||
    raw.trim()
  );
}

export function interpret(
  extract: RawExtract,
  profile: SchoolProfile,
  now = new Date()
): ReportModel {
  const warnings: Warning[] = [];
  const students: Student[] = [];

  for (const s of extract.students) {
    const push = (w: Omit<Warning, 'student'>) =>
      warnings.push({ ...w, student: s.displayName });

    const aggregator = s.markbooks.find((m) =>
      (m.description ?? '').startsWith(profile.aggregatorPrefix)
    );
    const subjectBooks = s.markbooks.filter((m) => m !== aggregator);

    const subjects = subjectBooks
      .map((m) => buildSubject(m, profile, push))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));

    // El agregador publica valores que el libro de la asignatura a veces no
    // trae — sobre todo los cualitativos. Se usa como fuente secundaria.
    if (aggregator) applyAggregator(aggregator, subjects, profile);
    reconcileAggregatorCoverage(aggregator, subjects, push);

    for (const sub of subjects)
      if (sub.qualitative)
        push({ code: 'QUALITATIVE_SUBJECT', severity: 'info', subject: sub.name,
          message: `${sub.name} usa escala conceptual; excluida del promedio general.` });

    const nums = subjects
      .filter((x) => !x.qualitative)
      .map((x) => x.final.value)
      .filter((v): v is number => v !== null);

    const periodLabels: string[] = [];
    const cellsPerPeriod: Record<string, number> = {};
    for (const sub of subjects)
      for (const per of sub.periods) {
        if (!periodLabels.includes(per.label)) periodLabels.push(per.label);
        cellsPerPeriod[per.label] = Math.max(cellsPerPeriod[per.label] ?? 0, per.cells.length);
      }
    periodLabels.sort((a, b) => a.localeCompare(b, 'es'));

    students.push({
      key: s.key, displayName: s.displayName, formGroup: s.formGroup, subjects,
      overall: nums.length ? r2(mean(nums)) : null, overallBasis: nums.length,
      periodLabels, cellsPerPeriod,
    });
  }

  const allPeriods = students.flatMap((s) => s.subjects.flatMap((x) => x.periods));
  const model: ReportModel = {
    schemaVersion: '1.0', tenant: extract.tenant, profileId: profile.id,
    extractedAt: extract.extractedAt, renderedAt: now.toISOString(),
    students, warnings,
    verification: {
      periodsChecked: allPeriods.length,
      reproduced: allPeriods.filter((x) => x.average.source === 'published').length,
      corrected: allPeriods.filter((x) => x.average.source === 'recalculated').length,
      estimated: allPeriods.filter((x) => x.average.source === 'estimated').length,
      mismatches: warnings.filter((w) => w.code === 'MODEL_MISMATCH').length,
    },
  };
  return model;
}

function applyAggregator(agg: RawMarkbook, subjects: Subject[], p: SchoolProfile) {
  const byName = new Map<string, RawColumn[]>();
  for (const c of agg.columns) {
    const n = c.parentGroupings[1]?.name;
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n)!.push(c);
  }
  for (const sub of subjects) {
    const cols = byName.get(sub.name) ?? byName.get(sub.sourceLabel);
    if (!cols) continue;
    const hasOwn = sub.periods.some((x) => x.average.value !== null);
    if (hasOwn) continue; // el libro propio manda
    for (const c of cols) {
      const g = toGrade(c.value, p);
      if (g.qualitative) {
        sub.qualitative = true;
        const low = c.name.toLowerCase();
        if (low.includes('final') || low.includes('anual'))
          sub.final = { value: null, source: 'qualitative', published: null, missingWeightPct: null, text: g.qualitative };
        else
          for (const per of sub.periods)
            if (low.includes(per.label.replace(/\D/g, '')))
              per.average = { value: null, source: 'qualitative', published: null, missingWeightPct: null, text: g.qualitative };
      }
    }
  }
}

/**
 * El agregador puede venir parcialmente poblado sin ninguna señal que lo
 * indique: en la muestra, el de un estudiante consolidaba 1 de 11 asignaturas.
 * Por eso el pipeline nunca lo usa como atajo de resumen, y lo avisa.
 */
function reconcileAggregatorCoverage(
  agg: RawMarkbook | undefined,
  subjects: Subject[],
  push: (w: Omit<Warning, 'student'>) => void
) {
  if (!agg) return;
  const covered = new Set(
    agg.columns.map((c) => c.parentGroupings[1]?.name).filter(Boolean) as string[]
  );
  if (covered.size < subjects.length)
    push({
      code: 'AGGREGATOR_INCOMPLETE', severity: 'warn',
      message: `El markbook agregador cubre ${covered.size} de ${subjects.length} asignaturas. Se recorrió cada libro por separado.`,
    });
}
