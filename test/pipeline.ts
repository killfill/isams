/** Extracción (contra mock) -> interpretación -> los tres renderers. */
import { start } from './mockserver.js';
import { extract } from '../src/extract.js';
import { interpret } from '../src/interpret.js';
import { RENDERERS, contentHash, FORMATS } from '../src/render/index.js';
import { britishroyal } from '../src/profiles/britishroyal.js';

const stop = await start(8731);
let pass = 0, failn = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); } else { failn++; console.log(`  FAIL ${n} ${d}`); }
};

const raw = await extract({
  tenant: 'britishroyal', accessToken: 'x', parentsPath: '1,9,8,4,7,6',
  delayMs: 0, baseUrl: 'http://127.0.0.1:8731/api/portals',
});

console.log('\n3. Extracción');
check('2 estudiantes', raw.students.length === 2);
const cols = raw.students.reduce((n, s) => n + s.markbooks.reduce((m, b) => m + b.columns.length, 0), 0);
check('209 columnas', cols === 209, String(cols));
const asJson = JSON.stringify(raw);
for (const pii of ['schoolId', 'SID1', 'dob', 'homeAddresses', 'Calle Falsa', 'schoolEmailAddress', 'religion', 'medicalFlag', 'latestPhotoPath'])
  check(`sin PII: ${pii}`, !asJson.includes(pii));

console.log('\n4. Interpretación');
const model = interpret(raw, britishroyal);
const v = model.verification;
check('30 periodos', v.periodsChecked === 30, String(v.periodsChecked));
check('0 desajustes de modelo', v.mismatches === 0);
check('2 distorsiones corregidas', v.corrected === 2, String(v.corrected));
check('modelo sin PII', !JSON.stringify(model).includes('schoolId'));

const mat = model.students[1].subjects.find((s) => s.name === 'Matemática')!;
check('Matemática S2: publicado 1.5 -> 4.9', mat.periods[1].average.value === 4.9 && mat.periods[1].average.published === 1.5);
check('  falta 70%', mat.periods[1].average.missingWeightPct === 70);
check('Biología reproduce 5.3', model.students[0].subjects.find((s) => s.name === 'Biologia')!.periods[0].average.value === 5.3);

console.log('\n5. Renderers');
for (const [fmt, r] of Object.entries(RENDERERS)) {
  const out = r.render(model, britishroyal, { year: 2026 });
  check(`${fmt} genera salida`, out.length > 500, `${out.length} bytes`);
  check(`${fmt} determinista`, out === r.render(model, britishroyal, { year: 2026 }));
  check(`${fmt} sin PII`, !out.includes('SID') && !/Calle Falsa/.test(out));
}
const csv = RENDERERS.csv.render(model, britishroyal);
const lines = csv.trim().split('\n');
check('csv: 1 fila por evaluación + cabecera', lines.length === 1 + model.students.flatMap(s => s.subjects.flatMap(x => x.periods.flatMap(p => p.cells))).length, String(lines.length));
// Contar campos respetando comillas: hay asignaturas con coma en el nombre.
const fields = (line: string) => {
  let n = 1, q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') i++; else q = !q; }
    else if (c === ',' && !q) n++;
  }
  return n;
};
const widths = new Set(lines.map(fields));
check('csv: todas las filas con 19 campos', widths.size === 1 && widths.has(19), [...widths].join('/'));
check('csv: entrecomilla nombres con coma', csv.includes('"Historia, Geografía y Ciencias Sociales"'));
const md = RENDERERS.md.render(model, britishroyal);
check('md: una sección por alumno', model.students.every((s) => md.includes(`## ${s.displayName}`)));
check('md: incluye la leyenda de modelos', md.includes('Cómo se calcula'));

// Estructura: persona primero, y dentro de cada persona un periodo a la vez.
const st0 = model.students[0];
/** El bloque de markdown que va desde el encabezado de un alumno al del siguiente. */
const seccion = (i: number) => {
  const desde = md.indexOf(`## ${model.students[i].displayName}`);
  const hasta = i + 1 < model.students.length ? md.indexOf(`## ${model.students[i + 1].displayName}`) : md.length;
  return md.slice(desde, hasta);
};
check('md: cada alumno abre con su resumen, antes de los periodos',
  model.students.every((s, i) => {
    const sec = seccion(i);
    const primerPeriodo = s.periodLabels.find((l) => (s.cellsPerPeriod[l] ?? 0) > 0);
    return sec.includes('### Resumen') &&
      (!primerPeriodo || sec.indexOf('### Resumen') < sec.indexOf(`### ${primerPeriodo}`));
  }));
check('md: el final de cada asignatura vive en el resumen',
  model.students.every((s, i) => seccion(i).split('### ')[1].includes('| Final |')));
check('md: una tabla por periodo con evaluaciones',
  st0.periodLabels.filter((l) => (st0.cellsPerPeriod[l] ?? 0) > 0).every((l) => md.includes(`### ${l}`)));
check('md: la grilla del periodo numera las columnas y cierra con Prom',
  /\| Asignatura \| 1 \| 2 \|.*\| Prom \|/.test(md), md.split('\n').find((l) => l.includes('| Prom |')));
check('md: los periodos de un alumno van antes del siguiente alumno', (() => {
  if (model.students.length < 2) return true;
  const corte = md.indexOf(`## ${model.students[1].displayName}`);
  const primerPeriodo = st0.periodLabels.find((l) => (st0.cellsPerPeriod[l] ?? 0) > 0)!;
  return md.indexOf(`### ${primerPeriodo}`) < corte;
})());
check('md: ya no hay detalle por asignatura', !md.includes('Detalle por asignatura'));
check('md: sin banda de resumen "Bajo"', !/\*\*Bajo /.test(md));
check('md: pero cada nota bajo la aprobación sigue marcada', md.includes('🔴'));
check('md: marca las evaluaciones sin nota', md.includes(' · '));
check('md: documenta las marcas que usa', md.includes('`=`') && md.includes('🚩'));
check('md: no anuncia marcas que ya no usa', !md.includes('▲'));

const html = RENDERERS.html.render(model, britishroyal, { year: 2026 });
check('html: sin banda de alertas', !html.includes('class="alert"'));
check('html: pero sigue marcando cada nota bajo la aprobación', html.includes('fail'));

// ── email: lo que un cliente de correo NO perdona ────────────────────────────
// Cada una de estas corresponde a algo verificado que rompe en Gmail o en el
// motor de Word de Outlook. Si alguna se cae, el correo llega roto y no hay
// forma de enterarse desde acá: el que lo ve es el apoderado.
const mail = RENDERERS.email.render(model, britishroyal, { year: 2026 });
const prohibido: [string, string][] = [
  ['<style', 'Gmail borra el bloque entero si pasa de ~8 KB o si algo no le gusta'],
  ['var(--', 'Gmail soporta var() pero no la declaración: quedaría sin color'],
  [':hover', 'no existe en correo'],
  ['data-tip', 'los tooltips cuelgan de :hover'],
  ['<link', 'los clientes quitan las hojas y fuentes externas'],
  ['background-image', 'Gmail ha borrado el bloque entero al verlo'],
  ['display:flex', 'el motor de Word no lo soporta'],
  ['display:grid', 'el motor de Word no lo soporta'],
  ['position:', 'sin soporte en el motor de Word'],
  ['::before', 'pseudo-elementos: se pierden'],
  ['::after', 'pseudo-elementos: se pierden'],
  ['overflow', 'no hay scroll interno en un correo'],
  ['class=', 'Gmail reescribe los nombres de clase'],
  ['float:', 'el motor de Word lo maqueta mal'],
  // Observado en Gmail: el título se encimó con la fecha y el nombre del alumno
  // con su promedio. El saneador trata los elementos de bloque dentro de una
  // celda de forma inconsistente; los saltos van con <br> y las columnas con
  // tablas anidadas.
  ['<div', 'Gmail encima los bloques dentro de una celda'],
  ['display:block', 'mismo problema: Gmail lo colapsa dentro de <td>'],
];
for (const [aguja, porque] of prohibido)
  check(`email: sin ${aguja} (${porque})`, !mail.includes(aguja));

check('email: maqueta con tablas', (mail.match(/<table/g) ?? []).length >= 3);
check('email: estilos en línea en cada elemento', (mail.match(/style="/g) ?? []).length > 50);
check('email: colores literales, no variables', /#[0-9A-Fa-f]{6}/.test(mail));
check('email: declara color-scheme para frenar la inversión', mail.includes('name="color-scheme"'));
// 600px es la convención de los correos de marketing; una matriz de ~20
// columnas no entra ahí y el punto es que se vea como el html revisado.
check('email: ancho acotado, pero al de una matriz', mail.includes('max-width:1000px'));
check('email: fluido por debajo de ese ancho', mail.includes('width:100%'));
check('email: cabe sin que Gmail lo recorte', mail.length < 102_400, `${mail.length} bytes`);
check('email: trae a los alumnos', model.students.every((s) => mail.includes(s.displayName)));
check('email: trae los finales', mail.includes('Final'));
// El CLI no sabe si quien envía va a adjuntar el informe, así que el pie no
// puede darlo por hecho: remite al informe HTML, que existe siempre.
check('email: no promete un adjunto que quizá no se mande', !mail.includes('adjunto'));
check('email: pero sí dice dónde están los nombres', mail.includes('informe HTML'));

// ❗ El correo tiene que traer TODAS las notas y con la MISMA forma que el
// html, que es la versión que se revisó. La matriz es la misma: una columna por
// evaluación agrupada por periodo, el promedio de cada periodo, el final. Lo
// que no viaja son los tooltips —no existen en correo—, así que las columnas
// quedan numeradas igual que allá pero sin poder decir cuál es cuál.
const celdasTodas = model.students.flatMap((st) =>
  st.subjects.flatMap((su) => su.periods.flatMap((per) => per.cells)));
const conNota = celdasTodas.filter((c) => c.value !== null);
const enPesos = (n: number) => n.toFixed(1).replace('.', ',');
const notasAusentes = [...new Set(conNota.map((c) => enPesos(c.value!)))].filter((n) => !mail.includes(n));
check(`email: trae las ${conNota.length} notas`, notasAusentes.length === 0, notasAusentes.join(' '));

// La grilla tiene exactamente la forma del html: por alumno, por asignatura,
// una celda de nombre + (n+1) por periodo con evaluaciones + una de final.
const celdasEsperadas = model.students.reduce((tot, st) => {
  const porPeriodo = st.periodLabels.reduce(
    (n, l) => n + ((st.cellsPerPeriod[l] ?? 0) > 0 ? (st.cellsPerPeriod[l] ?? 0) + 1 : 0), 0);
  return tot + st.subjects.length * (1 + porPeriodo + 1);
}, 0);
const celdasEnMail = (mail.match(/<td/g) ?? []).length;
check('email: la grilla tiene la forma de la del html',
  celdasEnMail >= celdasEsperadas, `${celdasEnMail} celdas, esperadas al menos ${celdasEsperadas}`);
check('email: agrupa las columnas por periodo, como el html', mail.includes('colspan='));
check('email: fija Asignatura y Final a lo alto de las dos filas de cabecera',
  (mail.match(/rowspan="2"/g) ?? []).length >= 2 * model.students.length);
check('email: encabeza cada periodo con su nombre',
  model.students[0].periodLabels.filter((l) => (model.students[0].cellsPerPeriod[l] ?? 0) > 0)
    .every((l) => mail.includes(l)));
check('email: columna de promedio por periodo', mail.includes('>Prom<'));
check('email: promedio general del alumno', mail.includes('Promedio general'));
// El fondo de la página lo pone el cliente: así el correo se ve parte de la
// bandeja y no un recorte pegado encima. Solo llevan fondo las celdas donde el
// gris significa algo.
check('email: el body no declara fondo', /<body style="[^"]*"/.test(mail) && !/<body style="[^"]*background/.test(mail));
check('email: sin el gris de página', !mail.includes('#ECEDEF'));
check('email: sin el fondo de tarjeta', !mail.includes('#FBFCFE'));
check('email: pero conserva el sombreado del bloque que más pesa', mail.includes('#F0F1F3'));
check('email: y el rojo bajo la nota de aprobación', mail.includes('#A32E2A'));
check('email: tacha el promedio publicado cuando lo corrige',
  !model.students.some((st) => st.subjects.some((su) => su.periods.some((pp) => pp.average.source === 'recalculated')))
  || mail.includes('line-through'));
check('email: explica que las columnas van numeradas', mail.includes('numeradas'));
check('email: usa <br> para separar, no bloques', mail.includes('<br>'));
// Margen real: esto crece con cada alumno y el recorte de Gmail es silencioso.
check('email: cabe bajo el recorte de Gmail', mail.length < 102_400, `${mail.length} bytes`);

// Un informe sin respaldo lo dice arriba, donde no se puede no verlo.
const roto = structuredClone(model);
roto.verification.mismatches = 2;
const mailRoto = RENDERERS.email.render(roto, britishroyal, { year: 2026 });
check('email: avisa cuando hay periodos sin respaldo', mailRoto.includes('sin respaldo'));
check('email: y lo pone antes que las notas',
  mailRoto.indexOf('sin respaldo') < mailRoto.indexOf(model.students[0].displayName));
check('email: sin desajustes no inventa la alerta', !mail.includes('sin respaldo'));

console.log('\n6. Huella del contenido');
// El problema que resuelve: el HTML lleva impresa la fecha de extracción, así
// que el md5 del archivo cambia en cada corrida aunque las notas sean idénticas
// y quien compara termina recortando la fecha a mano.
const masTarde = { ...model, extractedAt: '2027-03-04T09:15:00.000Z', renderedAt: '2027-03-04T09:15:01.000Z' };

for (const fmt of FORMATS) {
  const h = contentHash(model, britishroyal, fmt, { year: 2026 });
  check(`${fmt}: la huella es un md5`, /^[0-9a-f]{32}$/.test(h), h);
  check(`${fmt}: misma data, misma huella`, h === contentHash(model, britishroyal, fmt, { year: 2026 }));
  check(`${fmt}: otra fecha de extracción, misma huella`,
    h === contentHash(masTarde, britishroyal, fmt, { year: 2026 }));
}

// …y sin embargo el archivo sí cambia: por eso la huella no es md5sum.
const htmlAhora = RENDERERS.html.render(model, britishroyal, { year: 2026 });
const htmlDespues = RENDERERS.html.render(masTarde, britishroyal, { year: 2026 });
check('el archivo sí cambia con la fecha', htmlAhora !== htmlDespues);

// Lo que sí tiene que moverla.
const conNotaCambiada = structuredClone(model);
const celda = conNotaCambiada.students[0].subjects.flatMap((x: any) => x.periods.flatMap((p: any) => p.cells)).find((c: any) => c.value !== null);
celda.value = (celda.value ?? 0) + 1;
check('cambiar una nota cambia la huella',
  contentHash(model, britishroyal, 'html', { year: 2026 }) !== contentHash(conNotaCambiada, britishroyal, 'html', { year: 2026 }));
check('cambiar el año cambia la huella',
  contentHash(model, britishroyal, 'html', { year: 2026 }) !== contentHash(model, britishroyal, 'html', { year: 2027 }));

const huellas = FORMATS.map((f) => contentHash(model, britishroyal, f, { year: 2026 }));
check('cada formato tiene su propia huella', new Set(huellas).size === FORMATS.length);

stop();
console.log(`\n${pass} ok, ${failn} fallidas`);
process.exit(failn ? 1 : 0);
