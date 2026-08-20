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

function summaryRow(s: Subject, st: Student, p: SchoolProfile): string {
  const cols = st.periodLabels.map((l) => avg(s.periods.find((x) => x.label === l)?.average, p));
  const fin =
    s.final.source === 'qualitative'
      ? (s.final.text ?? '—')
      : `${fmt(s.final.value)}${s.final.value !== null && s.final.value < p.scale.pass ? ' 🔴' : ''}`;
  return `| ${cell(s.name)} | ${p.modelLabels[s.model].label} | ${cols.join(' | ')} | **${fin}** |`;
}

/** Fila de una evaluación individual. El peso es lo que explica el promedio. */
function cellRow(c: Cell): string {
  const bloque = (c.block ?? '—') + (c.heavier ? ' ▲' : '');
  const peso = c.weightPct !== null ? `${c.weightPct}%` : '—';
  const nota = c.value !== null ? fmt(c.value) : c.qualitative ? c.qualitative : '_pendiente_';
  const marca = c.derived ? ' *(promedio de proceso, no es una nota)*' : c.absent ? ' 🚩 ausente' : '';
  return `| ${cell(bloque)} | ${peso} | ${cell(c.label)} | ${nota}${marca} |`;
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
      '`🔴` bajo ' + fmt(p.scale.pass) + ' · `▲` bloque que más pesa · `🚩` inasistencia.',
    '',
  );

  for (const st of model.students) {
    out.push('---', '', `## ${st.displayName} — ${st.formGroup}`, '');
    out.push(`Promedio general: **${fmt(st.overall)}** (${st.overallBasis} asignaturas numéricas)`, '');

    // Matriz: asignaturas × periodos. Es la misma vista que encabeza el HTML.
    const head = ['Asignatura', 'Cálculo', ...st.periodLabels, 'Final'];
    out.push(`| ${head.join(' | ')} |`);
    out.push(`|${head.map(() => '---').join('|')}|`);
    for (const s of st.subjects) out.push(summaryRow(s, st, p));
    out.push('');

    const bajo: string[] = [];
    for (const s of st.subjects) {
      if (s.final.value !== null && s.final.value < p.scale.pass)
        bajo.push(`${s.name} final ${fmt(s.final.value)}`);
      for (const per of s.periods)
        if (per.average.value !== null && per.average.value < p.scale.pass)
          bajo.push(`${s.name} ${per.label} ${fmt(per.average.value)}`);
    }
    if (bajo.length) out.push(`> 🔴 **Bajo ${fmt(p.scale.pass)}:** ${bajo.join(' · ')}`, '');

    // Detalle: cada nota que entra al promedio, con su peso. Es lo que permite
    // rehacer el cálculo a mano y discutirlo con el colegio.
    out.push(`### Detalle por asignatura — ${st.displayName}`, '');
    for (const s of st.subjects) {
      const finTxt = s.final.source === 'qualitative' ? (s.final.text ?? '—') : fmt(s.final.value);
      out.push(`#### ${s.name} · ${p.modelLabels[s.model].label} · final **${finTxt}**`, '');

      for (const per of s.periods) {
        const a = per.average;
        const nota =
          a.source === 'recalculated'
            ? ` — ⚠️ la plataforma publica ${fmt(a.published)}, distorsionado por ${a.missingWeightPct}% de peso sin notas; corregido acá`
            : a.source === 'estimated'
              ? ' — periodo en curso, estimado con las notas presentes'
              : '';
        out.push(`**${per.label}** · promedio ${avg(a, p)}${nota}`, '');
        out.push('| Bloque | Peso | Evaluación | Nota |', '|---|---|---|---|');
        for (const c of per.cells) out.push(cellRow(c));
        out.push('');
      }
    }
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
