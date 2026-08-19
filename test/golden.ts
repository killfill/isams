import { readFileSync } from 'node:fs';
import { interpret } from '../src/interpret.js';
import { britishroyal } from '../src/profiles/britishroyal.js';
import type { RawExtract } from '../src/types.js';

const raw: RawExtract = JSON.parse(readFileSync('test/fixture.raw.json', 'utf8'));
const m = interpret(raw, britishroyal, new Date('2026-08-19T19:15:00Z'));

console.log('verificación:', m.verification);
console.log('\navisos por código:');
const by: Record<string, number> = {};
for (const w of m.warnings) by[w.code] = (by[w.code] ?? 0) + 1;
console.table(by);
for (const w of m.warnings.filter((x) => x.severity === 'error')) console.log('  ERROR', w.student, w.subject, w.period, w.message);

for (const s of m.students) {
  console.log(`\n=== ${s.displayName} (${s.formGroup}) general ${s.overall} sobre ${s.overallBasis}`);
  for (const sub of s.subjects)
    console.log(
      `  ${sub.name.slice(0, 30).padEnd(30)} ${sub.model.padEnd(8)} ` +
      sub.periods.map((p) => `${p.label.slice(-1)}:${p.average.value ?? p.average.text}[${p.average.source.slice(0, 4)}]`).join(' ') +
      `  FIN ${sub.final.value ?? sub.final.text}`
    );
}
