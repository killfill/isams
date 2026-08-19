import type { ReportModel, SchoolProfile } from '../types.js';
import type { RenderOptions } from './index.js';

/**
 * Formato largo (tidy): una fila por evaluación. Los promedios de periodo y
 * final se repiten en cada fila, que es redundante pero es lo que permite
 * pivotear directo en una planilla sin joins.
 *
 * Números con punto decimal para que Excel/Sheets los reconozcan como número
 * sin importar la configuración regional. El separador de campos es coma.
 */

const COLUMNS = [
  'alumno', 'curso', 'asignatura', 'modelo', 'periodo', 'grupo', 'peso_pct',
  'evaluacion', 'es_derivada', 'nota', 'valor_bruto', 'ausente', 'tiene_comentarios',
  'promedio_periodo', 'fuente_promedio', 'promedio_periodo_publicado',
  'promedio_final', 'fuente_final', 'promedio_general_alumno',
] as const;

function q(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const num = (n: number | null) => (n === null ? '' : String(n));

export function renderCsv(model: ReportModel, p: SchoolProfile, _opts: RenderOptions = {}): string {
  const rows: string[] = [COLUMNS.join(',')];

  for (const st of model.students)
    for (const sub of st.subjects)
      for (const per of sub.periods)
        for (const c of per.cells)
          rows.push(
            [
              st.displayName, st.formGroup, sub.name, p.modelLabels[sub.model].label,
              per.label, c.block ?? '', c.weightPct ?? '',
              c.label, c.derived ? 'si' : 'no',
              num(c.value), c.rawValue ?? '', c.absent ? 'si' : 'no', c.hasComments ? 'si' : 'no',
              num(per.average.value), per.average.source, num(per.average.published),
              sub.final.source === 'qualitative' ? (sub.final.text ?? '') : num(sub.final.value),
              sub.final.source,
              num(st.overall),
            ].map(q).join(',')
          );

  // Sin \r\n a propósito: LF es lo que esperan las herramientas unix del
  // workflow, y las planillas lo leen igual.
  return rows.join('\n') + '\n';
}
