import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Average, Cell, Period, ReportModel, SchoolProfile, Student, Subject } from '../types.js';
import type { RenderOptions } from './index.js';
import { fechaLarga } from './format.js';

const CSS = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Coma decimal: convención chilena. */
const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1).replace('.', ','));

// ─────────────────────────────── celdas ──────────────────────────────────────

function renderCell(c: Cell | null, p: SchoolProfile, firstOfBlock: boolean): string {
  if (!c) return '<td class="c empty"></td>';

  let cls = 'c';
  if (firstOfBlock) cls += ' bstart';
  if (c.derived) cls += ' der';
  if (c.heavier) cls += ' w70';

  const tip = c.derived
    ? `${c.label} — no es una nota: es el promedio de las evaluaciones de proceso, que el libro cuenta como una nota más`
    : `${c.label}${c.block ? ` · ${c.block}` : ''}`;

  if (c.value === null) {
    const txt = c.qualitative ? esc(c.qualitative) : '·';
    return `<td class="${cls} pend" data-tip="${esc(tip)} — sin nota"><span class="v">${txt}</span></td>`;
  }

  const marks =
    (c.derived ? '<i class="dm">=</i>' : '') +
    (c.absent ? '<i class="ab" data-tip="Inasistencia">A</i>' : '');
  const fail = c.value < p.scale.pass ? ' fail' : '';
  const bar = Math.round((c.value / p.scale.max) * 100);
  return `<td class="${cls}${fail}" data-tip="${esc(tip)}"><span class="v">${fmt(c.value)}</span>${marks}<span class="bar" style="width:${bar}%"></span></td>`;
}

function renderAverage(a: Average | null, p: SchoolProfile, kind: 'per' | 'fin'): string {
  if (!a) return `<td class="p ${kind} empty"></td>`;
  if (a.source === 'qualitative')
    return `<td class="p ${kind} qual"><span class="v">${esc(a.text ?? '—')}</span></td>`;
  if (a.value === null) return `<td class="p ${kind} empty">—</td>`;

  let sub = '';
  if (a.source === 'recalculated' && a.published !== null)
    sub = `<em class="was" data-tip="Promedio publicado por la plataforma, distorsionado: pondera como 0 el bloque de ${a.missingWeightPct}% que aún no tiene notas">${fmt(a.published)}</em>`;
  else if (a.source === 'estimated')
    sub = `<em class="est" data-tip="La plataforma aún no publica este promedio. Estimado con las notas ingresadas.">est</em>`;

  const fail = a.value < p.scale.pass ? ' fail' : '';
  return `<td class="p ${kind}${fail}"><span class="v">${fmt(a.value)}</span>${sub}</td>`;
}

// ─────────────────────────────── tabla ───────────────────────────────────────

function renderRow(sub: Subject, st: Student, p: SchoolProfile): string {
  const lbl = p.modelLabels[sub.model];
  const cells: string[] = [
    `<th class="asig" scope="row">${esc(sub.name)}<small data-tip="${esc(lbl.description)}">${esc(lbl.label)}</small></th>`,
  ];

  for (const label of st.periodLabels) {
    const n = st.cellsPerPeriod[label] ?? 0;
    if (n === 0) continue;
    const per: Period | undefined = sub.periods.find((x) => x.label === label);
    let prev: string | null | undefined;
    for (let i = 0; i < n; i++) {
      const c = per?.cells[i] ?? null;
      const first = c !== null && prev !== undefined && c.block !== prev;
      if (c) prev = c.block;
      cells.push(renderCell(c, p, first));
    }
    cells.push(renderAverage(per?.average ?? null, p, 'per'));
  }

  // El final publicado se muestra tachado solo cuando arrastra una distorsión
  // real, no una diferencia de redondeo.
  let sub2 = '';
  if (
    sub.final.source === 'recalculated' && sub.final.published !== null &&
    sub.final.value !== null && Math.abs(sub.final.published - sub.final.value) > 0.09
  ) {
    const dist = sub.periods.some((x) => x.average.source === 'recalculated');
    sub2 = dist
      ? `<em class="was" data-tip="Final publicado por la plataforma: hereda la distorsión del semestre">${fmt(sub.final.published)}</em>`
      : `<em class="was" data-tip="Final publicado por la plataforma; aún no refleja el periodo en curso">${fmt(sub.final.published)}</em>`;
  }
  if (sub.final.source === 'qualitative')
    cells.push(`<td class="p fin qual"><span class="v">${esc(sub.final.text ?? '—')}</span></td>`);
  else {
    const fail = sub.final.value !== null && sub.final.value < p.scale.pass ? ' fail' : '';
    cells.push(`<td class="p fin${fail}"><span class="v">${fmt(sub.final.value)}</span>${sub2}</td>`);
  }

  return `<tr>${cells.join('')}</tr>`;
}

function renderStudent(st: Student, p: SchoolProfile): string {
  const head1: string[] = ['<th class="asig" rowspan="2">Asignatura</th>'];
  const head2: string[] = [];
  for (const label of st.periodLabels) {
    const n = st.cellsPerPeriod[label] ?? 0;
    if (n === 0) continue;
    head1.push(`<th class="grp" colspan="${n + 1}">${esc(label)}</th>`);
    for (let i = 1; i <= n; i++) head2.push(`<th class="num">${i}</th>`);
    head2.push('<th class="pv">Prom</th>');
  }
  head1.push('<th class="fin" rowspan="2">Final</th>');

  // Sin barra de alertas: el informe muestra las notas —el 🔴 ya marca cada una
  // bajo la nota de aprobación— y quien lo lea decide qué destacar. Resumir
  // aparte cuáles son las malas es análisis, y ese no es trabajo del render.

  return `
<section class="alumno">
  <header class="ahead">
    <div><h2>${esc(st.displayName)}</h2><p class="sub">${esc(st.formGroup)} · ${st.subjects.length} asignaturas</p></div>
    <div class="gen"><span class="glabel">Promedio general</span><span class="gval">${fmt(st.overall)}</span></div>
  </header>
  <div class="scroller"><table>
    <thead><tr>${head1.join('')}</tr><tr>${head2.join('')}</tr></thead>
    <tbody>${st.subjects.map((s) => renderRow(s, st, p)).join('')}</tbody>
  </table></div>
</section>`;
}


export function renderHtml(model: ReportModel, p: SchoolProfile, opts: RenderOptions = {}): string {
  const tz = opts.timeZone ?? 'America/Santiago';
  const title = opts.year ? `${p.strings.title} ${opts.year}` : p.strings.title;
  const ml = p.modelLabels;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&family=Zilla+Slab:wght@500;600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="wrap">
<div class="top"><h1>${esc(title)}</h1>
<p>Extraído del portal el ${esc(fechaLarga(model.extractedAt, tz))}<br><span class="hint">Pasa el cursor sobre una nota para ver a qué evaluación corresponde</span></p></div>
${model.students.map((s) => renderStudent(s, p)).join('')}
<div class="foot">
<h3 class="ltit">Cómo se calcula el promedio del semestre</h3>
<dl class="models">
  <div><dt>${esc(ml.simple.label)}</dt><dd>${esc(ml.simple.description)}</dd></div>
  <div><dt>${esc(ml.weighted.label)}</dt><dd>${esc(ml.weighted.description)}</dd></div>
  <div><dt>${esc(ml.twoStep.label)}</dt><dd>${esc(ml.twoStep.description).replace('=', '<i class="eq">=</i>')}</dd></div>
  <div class="tint"><dt><i class="sw"></i>el fondo gris</dt><dd>${esc(p.strings.heavierBlockNote)}</dd></div>
</dl>
<p class="note">${esc(p.strings.distortionNote).replace(' est ', ' <em>est</em> ')}</p></div>
</div></body></html>`;
}
