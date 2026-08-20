import { createHash } from 'node:crypto';
import type { ReportModel, SchoolProfile } from '../types.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import { renderCsv } from './csv.js';

export interface RenderOptions {
  timeZone?: string;
  /** Año académico para el título. Si se omite, no se muestra. */
  year?: string | number;
}

export type Format = 'html' | 'md' | 'csv';

export interface Renderer {
  render: (m: ReportModel, p: SchoolProfile, o?: RenderOptions) => string;
  extension: string;
  mime: string;
}

/** Agregar un formato = agregar un archivo y una línea acá. */
export const RENDERERS: Record<Format, Renderer> = {
  html: { render: renderHtml, extension: 'html', mime: 'text/html' },
  md: { render: renderMarkdown, extension: 'md', mime: 'text/markdown' },
  csv: { render: renderCsv, extension: 'csv', mime: 'text/csv' },
};

export const FORMATS = Object.keys(RENDERERS) as Format[];
export const isFormat = (s: string): s is Format => FORMATS.includes(s as Format);

/**
 * Huella del contenido, estable entre corridas.
 *
 * El md5 del archivo tal cual no sirve para comparar dos informes: el HTML y el
 * Markdown llevan impresa la fecha de extracción, así que dos corridas con las
 * mismas notas dan archivos distintos. Quien consume la salida termina teniendo
 * que recortar la fecha a mano para comparar, y ese recorte es frágil.
 *
 * Esto renderiza una segunda vez con los dos sellos de tiempo del modelo puestos
 * en un valor fijo, y saca el md5 de eso. Misma data, misma huella —hoy, mañana,
 * o releyendo un `--save-raw` de la semana pasada.
 *
 * Cubre todo lo demás del archivo, el CSS incluido: si cambia el renderizador,
 * cambia la huella. Eso es deliberado —la pregunta que responde es "¿es este el
 * mismo archivo que ya tengo?", no "¿cambiaron las notas?".
 *
 * ❗ A propósito NO coincide con `md5sum archivo`.
 */
const SELLO_FIJO = '1970-01-01T00:00:00.000Z';

export function contentHash(
  model: ReportModel,
  profile: SchoolProfile,
  format: Format,
  opts?: RenderOptions
): string {
  const canonico = RENDERERS[format].render(
    { ...model, extractedAt: SELLO_FIJO, renderedAt: SELLO_FIJO },
    profile,
    opts
  );
  return createHash('md5').update(canonico, 'utf8').digest('hex');
}
