/**
 * El mismo informe del HTML, para el cuerpo de un correo.
 *
 * Misma estructura y misma lectura visual que `html.ts`: la matriz por alumno,
 * una columna por evaluación agrupada por periodo, el promedio de cada periodo
 * y el final a la derecha. Lo que cambia es cómo se consigue, porque un cliente
 * de correo no es un navegador. Comprobado:
 *
 * - Gmail acepta `<style>` en el head, pero **borra el bloque entero** si pasa
 *   de ~8 KB, si encuentra una regla que no le gusta, o si adentro hay un
 *   `background-image: url(...)`. El CSS del informe web ya va en 6,6 KB.
 * - Gmail soporta la función `var()` pero **no la declaración** de la variable.
 *   El informe web resuelve 50 colores con `var(--…)`: quedarían todos sin valor.
 * - Outlook de escritorio renderiza con el motor de Word: sin flex, sin grid,
 *   sin `position`, sin `float`, sin variables.
 * - Gmail recorta el mensaje cerca de los 102 KB, sin avisar.
 *
 * Así que acá no hay ni un `<style>`: cada estilo va en su elemento, con colores
 * literales y maquetación de tablas. Tampoco hay `<div>` ni `display:block`
 * dentro de una celda: el saneador de Gmail los trata de forma inconsistente y
 * el resultado observado fue el título encimado con la fecha, y el nombre del
 * alumno encimado con su promedio. Donde hace falta un salto va un `<br>`, y
 * donde hace falta una columna va una tabla anidada. Cada byte cuenta —los estilos se repiten en
 * cientos de celdas—, de ahí que las constantes de estilo estén factorizadas y
 * los stacks de fuentes sean cortos.
 *
 * El fondo de la página no se declara: ni el `body`, ni la tabla exterior, ni el
 * contenedor traen `background-color`. Lo pone el cliente, que es lo que hace
 * que el correo se vea parte de la bandeja y no un recorte pegado encima. Solo
 * quedan con fondo las celdas donde el gris significa algo. La contrapartida es
 * que en modo oscuro el resultado depende del cliente: los textos llevan color
 * explícito y va declarado `color-scheme: light`, pero un cliente que lo ignore
 * pintará oscuro detrás de ellos.
 *
 * Tres cosas del HTML no se pueden traer y no hay forma de disimularlo:
 *
 * - **Los tooltips.** El HTML cuelga de `:hover` el nombre de cada evaluación,
 *   que es lo que explica las columnas numeradas. En correo no existen, y el pie
 *   remite al informe HTML sin afirmar que vaya adjunto: si va o no lo decide
 *   quien envía, y el CLI no tiene forma de saberlo.
 * - **La primera columna fija** (`position:sticky`) al desplazar la tabla.
 * - **La barrita bajo cada nota** (`position:absolute`), que era decorativa.
 */
import type { Average, Cell, Period, ReportModel, SchoolProfile, Student, Subject } from '../types.js';
import type { RenderOptions } from './index.js';
import { fechaLarga } from './format.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1).replace('.', ','));

/** Literales: `var()` sin declaración no sirve de nada en Gmail. */
const C = {
  ink: '#1E1F21', ink2: '#6A6B6D', rule: '#D5D6D8', rule2: '#E7E8EA',
  pass: '#2E6B57', fail: '#A32E2A', pend: '#B6B7B9',
  // Fondos que significan algo: el bloque que más pesa, la fila derivada, las
  // columnas de promedio, la celda vacía. El fondo de la PÁGINA no se declara
  // —ver la nota de arriba—, así que no hay ni `paper` ni `card`.
  der: '#F5F6F8', w70: '#F0F1F3', prom: '#F5F6F8', fin: '#F1F2F4', empty: '#F4F5F7',
};

// Sin `<link>` a Google Fonts: los clientes lo quitan. Estos son los sustitutos
// seguros de Zilla Slab e IBM Plex Mono, y van cortos porque se repiten en cada
// celda —el motor de Word no hereda la fuente dentro de una tabla.
const SANS = 'Arial,sans-serif';
const MONO = 'monospace';
const SERIF = "Georgia,'Times New Roman',serif";

const TH_BASE = `font-family:${SANS};font-weight:500;font-size:10.5px;color:${C.ink2};` +
  `text-transform:uppercase;letter-spacing:.1em;padding:7px 6px;`;
const CELL = `padding:7px 6px;text-align:center;border-bottom:1px solid ${C.rule2};`;

/** Una evaluación: mismo tratamiento que `.c` en el HTML. */
function gradeCell(c: Cell | null, p: SchoolProfile, firstOfBlock: boolean): string {
  const izq = firstOfBlock ? `border-left:1px dotted ${C.rule};` : '';
  if (!c)
    return `<td bgcolor="${C.empty}" style="${CELL}${izq}background-color:${C.empty};">&nbsp;</td>`;

  // Fondo gris para el bloque que más pesa, y para la fila derivada: es la señal
  // que el HTML usa para que se vea de dónde sale el promedio.
  //
  // La celda normal no declara fondo: lo hereda de la tabla. Parece un detalle,
  // pero declararlo son ~40 bytes repetidos en cada una de las celdas sin
  // sombrear, y el mensaje entero tiene que caber bajo el recorte de Gmail.
  const fondo = c.derived ? C.der : c.heavier ? C.w70 : null;
  const pinta = fondo ? ` bgcolor="${fondo}"` : '';
  const base = `<td${pinta} style="${CELL}${izq}${fondo ? `background-color:${fondo};` : ''}`;

  if (c.value === null) {
    const txt = c.qualitative ? esc(c.qualitative) : '·';
    return `${base}font-family:${MONO};font-size:12px;color:${C.pend};">${txt}</td>`;
  }
  const color = c.value < p.scale.pass ? C.fail : c.derived ? C.ink2 : C.ink;
  const italica = c.derived ? 'font-style:italic;' : '';
  const ausente = c.absent ? `<span style="color:${C.fail};font-size:9px;"> A</span>` : '';
  return `${base}font-family:${MONO};font-size:14px;${italica}color:${color};">${fmt(c.value)}${ausente}</td>`;
}

/** Un promedio: `.p` y `.p.fin` del HTML, con el publicado tachado debajo. */
function avgCell(a: Average | null, p: SchoolProfile, kind: 'per' | 'fin'): string {
  const fondo = kind === 'fin' ? C.fin : C.prom;
  const borde = kind === 'fin' ? C.rule : C.rule2;
  const base = `<td bgcolor="${fondo}" style="${CELL}border-left:1px solid ${borde};` +
    `background-color:${fondo};font-family:${MONO};`;

  if (!a) return `${base}">&nbsp;</td>`;
  if (a.source === 'qualitative')
    return `${base}font-size:13px;color:${C.ink2};">${esc(a.text ?? '—')}</td>`;
  if (a.value === null) return `${base}font-size:13px;color:${C.ink2};">—</td>`;

  let sub = '';
  if (a.source === 'recalculated' && a.published !== null)
    sub = `<br><span style="font-size:10px;color:${C.ink2};text-decoration:line-through;">${fmt(a.published)}</span>`;
  else if (a.source === 'estimated')
    sub = `<br><span style="font-size:10px;color:${C.ink2};">est</span>`;

  const color = a.value < p.scale.pass ? C.fail : C.ink;
  const tam = kind === 'fin' ? '16px' : '15px';
  return `${base}font-size:${tam};font-weight:700;color:${color};">${fmt(a.value)}${sub}</td>`;
}

/** Una fila: la asignatura y todas sus notas, igual que `renderRow` del HTML. */
function subjectRow(sub: Subject, st: Student, p: SchoolProfile): string {
  const lbl = p.modelLabels[sub.model];
  const celdas: string[] = [
    `<td style="${CELL}text-align:left;padding-left:14px;font-family:${SANS};font-size:13px;` +
      `color:${C.ink};">${esc(sub.name)}` +
      `<br><span style="font-size:10px;color:${C.ink2};">${esc(lbl.label)}</span></td>`,
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
      celdas.push(gradeCell(c, p, first));
    }
    celdas.push(avgCell(per?.average ?? null, p, 'per'));
  }
  celdas.push(avgCell(sub.final, p, 'fin'));
  return `<tr>${celdas.join('')}</tr>`;
}

function studentBlock(st: Student, p: SchoolProfile): string {
  const head1: string[] = [
    `<th rowspan="2" style="${TH_BASE}text-align:left;padding-left:14px;">Asignatura</th>`,
  ];
  const head2: string[] = [];
  for (const label of st.periodLabels) {
    const n = st.cellsPerPeriod[label] ?? 0;
    if (n === 0) continue;
    head1.push(
      `<th colspan="${n + 1}" style="${TH_BASE}color:${C.ink};letter-spacing:.14em;` +
        `border-bottom:1px solid ${C.rule2};">${esc(label)}</th>`
    );
    for (let i = 1; i <= n; i++)
      head2.push(`<th style="${TH_BASE}font-family:${MONO};letter-spacing:0;">${i}</th>`);
    head2.push(`<th style="${TH_BASE}color:${C.ink};border-left:1px solid ${C.rule2};">Prom</th>`);
  }
  head1.push(`<th rowspan="2" style="${TH_BASE}color:${C.ink};border-left:1px solid ${C.rule};">Final</th>`);

  // La cabecera del alumno: en el HTML es flex; acá, dos celdas de una tabla.
  return `
<tr><td style="padding:22px 16px 10px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
   <tr>
    <td style="font-family:${SERIF};font-size:21px;font-weight:600;color:${C.ink};">${esc(st.displayName)}<br><span style="font-family:${SANS};font-size:11px;font-weight:400;color:${C.ink2};">${esc(st.formGroup)} · ${st.subjects.length} asignaturas</span></td>
    <td align="right" style="text-align:right;font-family:${SANS};font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:${C.ink2};">Promedio general<br><span style="font-family:${MONO};font-size:30px;font-weight:500;color:${C.pass};">${fmt(st.overall)}</span></td>
   </tr>
  </table>
</td></tr>
<tr><td style="padding:0 16px 4px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"
         style="width:100%;border-collapse:collapse;border:1px solid ${C.rule};">
    <thead><tr>${head1.join('')}</tr><tr>${head2.join('')}</tr></thead>
    <tbody>${st.subjects.map((s) => subjectRow(s, st, p)).join('')}</tbody>
  </table>
</td></tr>`;
}

export function renderEmail(model: ReportModel, p: SchoolProfile, opts: RenderOptions = {}): string {
  const tz = opts.timeZone ?? 'America/Santiago';
  const title = opts.year ? `${p.strings.title} ${opts.year}` : p.strings.title;
  const ml = p.modelLabels;
  const v = model.verification;

  const pie = (t: string) =>
    `<tr><td style="padding:0 16px 12px;font-family:${SANS};font-size:11.5px;color:${C.ink2};line-height:1.55;">${t}</td></tr>`;

  // Un informe que no se puede respaldar lo dice arriba, no al pie.
  const alerta = v.mismatches
    ? `<tr><td style="padding:10px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="width:100%;border-collapse:collapse;"><tr><td bgcolor="#FBEDEC" style="background-color:#FBEDEC;
        border-left:4px solid ${C.fail};padding:10px 12px;font-family:${SANS};font-size:12.5px;color:${C.fail};line-height:1.5;">
        <strong>${v.mismatches} periodo(s) sin respaldo.</strong> Ningún modelo conocido reproduce el promedio
        publicado, así que esos números no son confiables.</td></tr></table></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;width:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="width:100%;border-collapse:collapse;">
<tr><td align="center" style="padding:18px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
       style="width:100%;max-width:1000px;border-collapse:collapse;border:1px solid ${C.rule};">
  <tr><td style="padding:20px 16px 2px;font-family:${SERIF};font-size:26px;font-weight:600;color:${C.ink};">${esc(title)}</td></tr>
  <tr><td style="padding:0 16px 8px;font-family:${SANS};font-size:11.5px;color:${C.ink2};">Extraído del portal el ${esc(fechaLarga(model.extractedAt, tz))}</td></tr>
  ${alerta}
  ${model.students.map((s) => studentBlock(s, p)).join('')}
  <tr><td style="padding:20px 16px 8px;font-family:${SANS};font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${C.ink2};border-top:1px solid ${C.rule};">Cómo se calcula el promedio del semestre</td></tr>
  ${pie(
    [ml.simple, ml.weighted, ml.twoStep]
      .map((m) => `<strong style="color:${C.ink};">${esc(m.label)}</strong> — ${esc(m.description)}`)
      .join('<br>') +
      `<br><strong style="color:${C.ink};">el fondo gris</strong> — ${esc(p.strings.heavierBlockNote)}`
  )}
  ${pie(esc(p.strings.distortionNote))}
  ${pie(
    `Las columnas van numeradas en el orden en que el libro publica las evaluaciones. ` +
      `El nombre de cada una no se puede mostrar en un correo: está en el informe HTML, ` +
      `pasando el cursor sobre la nota.`
  )}
</table>
</td></tr></table>
</body></html>`;
}
