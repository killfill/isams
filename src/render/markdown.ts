import type { Average, Cell, ReportModel, SchoolProfile, Student, Subject } from '../types.js';
import type { RenderOptions } from './index.js';
import { fechaLarga } from './format.js';

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1).replace('.', ','));
/** Escapa lo que rompería una celda de tabla markdown. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Un promedio en una celda de tabla. Cuando el valor corregido difiere del que
 * publica la plataforma, se muestran los dos: el corregido manda, el publicado
 * queda a la vista para que se pueda auditar la diferencia.
 */
function avg(a: Average | undefined, p: SchoolProfile): string {
  if (!a) return '';
  if (a.source === 'qualitative') return a.text ?? '—';
  if (a.value === null) return '—';

  const v = fmt(a.value);
  const bajo = a.value < p.scale.pass ? ' 🔴' : '';

  if (a.source === 'recalculated' && a.published !== null)
    return `**${v}**${bajo} ⚠️ pub. ${fmt(a.published)}`;
  if (a.source === 'estimated') return `${v}${bajo} *(est)*`;
  return `${v}${bajo}`;
}

/** Fila del resumen: la asignatura contra cada periodo, más el final. */
function summaryRow(s: Subject, st: Student, p: SchoolProfile): string {
  const cols = st.periodLabels.map((l) => avg(s.periods.find((x) => x.label === l)?.average, p));
  const fin =
    s.final.source === 'qualitative'
      ? (s.final.text ?? '—')
      : `${fmt(s.final.value)}${s.final.value !== null && s.final.value < p.scale.pass ? ' 🔴' : ''}`;
  return `| ${cell(s.name)} | ${p.modelLabels[s.model].label} | ${cols.join(' | ')} | **${fin}** |`;
}

/**
 * Una evaluación dentro de la grilla del semestre.
 *
 * Las columnas van numeradas y no con el nombre de la evaluación porque cada
 * asignatura tiene los suyos: en la columna 2 de una está "Ev. 2" y en la de
 * otra "Nota Parcial 1". El nombre es además una etiqueta opaca de la API, que
 * sirve para mostrar y nunca para deducir orden ni fecha.
 */
function gridCell(c: Cell | null, p: SchoolProfile): string {
  if (!c) return '';
  if (c.value === null) return c.qualitative ? cell(c.qualitative) : '·';
  const marcas = (c.derived ? ' `=`' : '') + (c.absent ? ' 🚩' : '');
  const bajo = c.value < p.scale.pass ? ' 🔴' : '';
  return `${fmt(c.value)}${bajo}${marcas}`;
}

/**
 * Una tabla por alumno y por periodo: asignaturas en las filas, evaluaciones en
 * las columnas, el promedio del periodo al final. Es la misma vista del HTML,
 * cortada por semestre —markdown no tiene columnas agrupadas, así que la tabla
 * ancha de allá se parte en una por periodo en vez de crecer sin fin a la derecha.
 */
function periodTable(st: Student, label: string, p: SchoolProfile): string[] {
  const n = st.cellsPerPeriod[label] ?? 0;
  // Sin evaluaciones no hay grilla que dibujar; el promedio del periodo ya salió
  // en el resumen. Es el caso de los periodos agregados tipo "PROMEDIOS 2026".
  if (n === 0) return [];

  const conEstePeriodo = st.subjects
    .map((s) => ({ s, per: s.periods.find((x) => x.label === label) }))
    .filter((x) => x.per !== undefined);
  if (!conEstePeriodo.length) return [];

  const head = ['Asignatura', ...Array.from({ length: n }, (_, i) => String(i + 1)), 'Prom'];
  const out = [`### ${label}`, '', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const { s, per } of conEstePeriodo) {
    const celdas = Array.from({ length: n }, (_, i) => gridCell(per!.cells[i] ?? null, p));
    out.push(`| ${cell(s.name)} | ${celdas.join(' | ')} | ${avg(per!.average, p)} |`);
  }
  out.push('');
  return out;
}

export function renderMarkdown(model: ReportModel, p: SchoolProfile, opts: RenderOptions = {}): string {
  const tz = opts.timeZone ?? 'America/Santiago';
  const out: string[] = [];
  const title = opts.year ? `${p.strings.title} ${opts.year}` : p.strings.title;
  const v = model.verification;

  out.push(`# ${title}`, '');
  out.push(`Extraído del portal el ${fechaLarga(model.extractedAt, tz)}.`, '');

  // Cómo leer los números, antes de los números. Sin esto, quien lea el informe
  // no sabe que algunos promedios contradicen a propósito lo que publica el
  // colegio.
  out.push(
    `> **Los promedios de este informe se calculan acá, no se copian de la plataforma.**`,
    `> El colegio publica un promedio por periodo, y en el modelo ponderado ese valor`,
    `> se distorsiona: cuando un bloque con peso todavía no tiene notas, la plataforma`,
    `> lo pondera como **0** en vez de excluirlo, y el promedio se hunde (un 30% con`,
    `> 4,9 y un 70% aún sin notas se publica como 1,5 en lugar de 4,9). Cada periodo`,
    `> se reproduce a partir de las notas: si el valor publicado se reproduce, se usa;`,
    `> si está distorsionado, se renormaliza sobre los bloques que sí tienen notas y`,
    `> se marca **⚠️ pub.** con el valor publicado al lado.`,
    '',
  );
  out.push(
    `Control de calidad: ${v.periodsChecked} periodos · ${v.reproduced} reproducidos · ` +
      `${v.corrected} corregidos · ${v.estimated} estimados · **${v.mismatches} desajustes**.`,
    '',
  );
  out.push(
    'Marcas: `⚠️ pub. X` promedio publicado distorsionado, corregido acá · ' +
      '`(est)` periodo en curso, estimado con las notas presentes · ' +
      '`🔴` bajo ' + fmt(p.scale.pass) + ' · `🚩` inasistencia · ' +
      '`=` no es una nota: es el promedio de las evaluaciones de proceso, que el libro ' +
      'cuenta como una más · `·` evaluación sin nota todavía.',
    '',
  );

  for (const st of model.students) {
    out.push('---', '', `## ${st.displayName} — ${st.formGroup}`, '');
    out.push(`Promedio general: **${fmt(st.overall)}** (${st.overallBasis} asignaturas numéricas)`, '');

    // Resumen: asignaturas × periodos. Es donde vive el final, que por definición
    // no cabe en la tabla de un periodo.
    const head = ['Asignatura', 'Cálculo', ...st.periodLabels, 'Final'];
    out.push('### Resumen', '', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    for (const s of st.subjects) out.push(summaryRow(s, st, p));
    out.push('');

    // Y después el detalle, un periodo a la vez.
    for (const label of st.periodLabels) out.push(...periodTable(st, label, p));
  }

  out.push('---', '', '## Cómo se calcula el promedio del semestre', '');
  for (const k of ['simple', 'weighted', 'twoStep'] as const)
    out.push(`- **${p.modelLabels[k].label}** — ${p.modelLabels[k].description}`);
  out.push(
    '',
    'Solo el modelo ponderado sufre la distorsión por bloque vacío: los otros dos',
    'excluyen las filas sin nota en vez de contarlas como cero.',
    '',
  );

  if (model.warnings.length) {
    out.push('## Avisos', '');
    for (const w of model.warnings)
      out.push(
        `- **${w.code}** (${w.severity}) · ${w.student}${w.subject ? ` · ${w.subject}` : ''}: ${w.message}`,
      );
    out.push('');
  }

  return out.join('\n');
}
