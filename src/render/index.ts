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
