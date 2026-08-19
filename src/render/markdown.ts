import type { Average, ReportModel, SchoolProfile, Student, Subject } from '../types.js';
import type { RenderOptions } from './index.js';
import { fechaLarga } from './format.js';

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1).replace('.', ','));
/** Escapa lo que rompería una celda de tabla markdown. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function avg(a: Average | undefined, p: SchoolProfile): string {
  if (!a) return '';
  if (a.source === 'qualitative') return a.text ?? '—';
  if (a.value === null) return '—';
  const v = fmt(a.value);
  if (a.source === 'recalculated') return `**${v}** ⚠️`;
  if (a.source === 'estimated') return `${v} *(est)*`;
  return v;
}

function subjectRow(s: Subject, st: Student, p: SchoolProfile): string {
  const cols = st.periodLabels.map((l) => avg(s.periods.find((x) => x.label === l)?.average, p));
  const fin = s.final.source === 'qualitative' ? (s.final.text ?? '—') : fmt(s.final.value);
  const bold = s.final.value !== null && s.final.value < p.scale.pass ? `**${fin}**` : `**${fin}**`;
  return `| ${cell(s.name)} | ${p.modelLabels[s.model].label} | ${cols.join(' | ')} | ${bold} |`;
}

export function renderMarkdown(model: ReportModel, p: SchoolProfile, opts: RenderOptions = {}): string {
  const tz = opts.timeZone ?? 'America/Santiago';
  const out: string[] = [];
  const title = opts.year ? `${p.strings.title} ${opts.year}` : p.strings.title;

  out.push(`# ${title}`, '');
  out.push(`Extraído del portal el ${fechaLarga(model.extractedAt, tz)}.`, '');

  for (const st of model.students) {
    out.push(`## ${st.displayName} — ${st.formGroup}`, '');
    out.push(`Promedio general: **${fmt(st.overall)}** (${st.overallBasis} asignaturas numéricas)`, '');

    const head = ['Asignatura', 'Cálculo', ...st.periodLabels, 'Final'];
    out.push(`| ${head.join(' | ')} |`);
    out.push(`|${head.map(() => '---').join('|')}|`);
    for (const s of st.subjects) out.push(subjectRow(s, st, p));
    out.push('');

    const bajo: string[] = [];
    for (const s of st.subjects) {
      if (s.final.value !== null && s.final.value < p.scale.pass)
        bajo.push(`${s.name} final ${fmt(s.final.value)}`);
      for (const per of s.periods)
        if (per.average.value !== null && per.average.value < p.scale.pass)
          bajo.push(`${s.name} ${per.label} ${fmt(per.average.value)}`);
    }
    if (bajo.length) out.push(`> ⚠️ **Bajo ${fmt(p.scale.pass)}:** ${bajo.join(' · ')}`, '');

    // Detalle por asignatura
    out.push(`### Detalle — ${st.displayName}`, '');
    for (const s of st.subjects) {
      out.push(`#### ${s.name}`, '');
      for (const per of s.periods) {
        const a = per.average;
        const nota =
          a.source === 'recalculated'
            ? ` — ⚠️ publicado ${fmt(a.published)} distorsionado (falta ${a.missingWeightPct}%), corregido`
            : a.source === 'estimated'
              ? ' — periodo en curso, estimado'
              : '';
        out.push(`**${per.label}** · ${p.modelLabels[per.model].label} · promedio ${avg(a, p)}${nota}`, '');
        out.push('| Grupo | Evaluación | Nota |', '|---|---|---|');
        for (const c of per.cells) {
          const val =
            c.value !== null ? fmt(c.value) : c.qualitative ? c.qualitative : '_pendiente_';
          const marca = c.derived ? ' *(promedio de proceso)*' : c.absent ? ' 🚩 ausente' : '';
          out.push(`| ${cell(c.block ?? '—')} | ${cell(c.label)} | ${val}${marca} |`);
        }
        out.push('');
      }
      out.push(`_Final: **${s.final.source === 'qualitative' ? s.final.text : fmt(s.final.value)}**_`, '');
    }
  }

  out.push('---', '', '## Cómo se calcula el promedio del semestre', '');
  for (const k of ['simple', 'weighted', 'twoStep'] as const)
    out.push(`- **${p.modelLabels[k].label}** — ${p.modelLabels[k].description}`);
  out.push('', p.strings.distortionNote, '');

  if (model.warnings.some((w) => w.severity !== 'info')) {
    out.push('## Avisos', '');
    for (const w of model.warnings.filter((x) => x.severity !== 'info'))
      out.push(`- **${w.code}** (${w.student}${w.subject ? ` · ${w.subject}` : ''}): ${w.message}`);
    out.push('');
  }

  return out.join('\n');
}
