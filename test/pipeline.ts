/** Extracción (contra mock) -> interpretación -> los tres renderers. */
import { start } from './mockserver.js';
import { extract } from '../src/extract.js';
import { interpret } from '../src/interpret.js';
import { RENDERERS } from '../src/render/index.js';
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

stop();
console.log(`\n${pass} ok, ${failn} fallidas`);
process.exit(failn ? 1 : 0);
