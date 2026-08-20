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
