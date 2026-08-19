import { readFileSync, writeFileSync } from 'node:fs';
import { interpret } from '../src/interpret.js';
import { profileFor } from '../src/profiles/index.js';
import { RENDERERS, FORMATS } from '../src/render/index.js';
import type { RawExtract } from '../src/types.js';

const raw: RawExtract = JSON.parse(readFileSync('test/fixture.raw.json', 'utf8'));
const profile = profileFor('britishroyal')!;
const model = interpret(raw, profile, new Date('2026-08-19T19:15:00Z'));
console.log('verificación:', model.verification);
for (const f of FORMATS) {
  const out = RENDERERS[f].render(model, profile, { year: "2026" });
  writeFileSync(`/tmp/salida.${f}`, out);
  console.log(`${f.padEnd(5)} ${String(out.length).padStart(7)} bytes`);
}
