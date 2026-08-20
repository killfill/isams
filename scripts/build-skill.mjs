// Compila src/ a JavaScript plano dentro del skill, para que el CLI viaje
// embebido y corra con `node` sin npm install ni node_modules.
//
//   node scripts/build-skill.mjs           reconstruye la copia embebida
//   node scripts/build-skill.mjs --check   falla si quedó desactualizada
//   node scripts/build-skill.mjs --pack    reconstruye y empaqueta el .zip
//
// El CLI no tiene dependencias de runtime (solo node:fs, node:path, node:url),
// así que basta con tsc: no hace falta bundler.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const SKILL = join(ROOT, '.claude', 'skills', 'isams-boletin');
const OUT = join(SKILL, 'cli');
const STAMP = join(OUT, 'BUILD.json');

const check = process.argv.includes('--check');
const pack = process.argv.includes('--pack');

/** Lista recursiva de archivos bajo dir, en orden estable. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (e.name === '.DS_Store') return [];
      return [p];
    });
}

/** Huella del código fuente: cambia si cambia cualquier archivo de src/. */
function hashSrc() {
  const h = createHash('sha256');
  for (const f of walk(SRC)) {
    h.update(relative(ROOT, f));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

const srcHash = hashSrc();

if (check) {
  if (!existsSync(STAMP)) {
    console.error('El CLI embebido no existe. Corre: npm run build:skill');
    process.exit(1);
  }
  const stamp = JSON.parse(readFileSync(STAMP, 'utf8'));
  if (stamp.srcHash !== srcHash) {
    console.error(
      `El CLI embebido en el skill quedó desactualizado.\n` +
        `  src/ actual:  ${srcHash}\n` +
        `  skill tiene:  ${stamp.srcHash} (construido ${stamp.builtAt})\n` +
        `Corre: npm run build:skill`,
    );
    process.exit(1);
  }
  console.log(`CLI embebido al día (${srcHash}).`);
  process.exit(0);
}

// 1. Compilar TypeScript a ESM plano.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'inherit' });

// 2. Copiar los assets que tsc no toca. html.ts lee styles.css en runtime,
//    relativo a su propio módulo, así que tiene que quedar al lado.
mkdirSync(join(OUT, 'render'), { recursive: true });
copyFileSync(join(SRC, 'render', 'styles.css'), join(OUT, 'render', 'styles.css'));

// 3. Marcar la carpeta como ESM: sin esto Node interpreta los .js como CommonJS.
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

// 4. Sello de versión, para que la deriva contra src/ sea detectable.
const builtAt = new Date().toISOString();
writeFileSync(STAMP, JSON.stringify({ srcHash, builtAt, node: process.version }, null, 2) + '\n');

// 5. Humo: si el bundle no arranca, mejor fallar acá que en manos del usuario.
const help = execFileSync('node', [join(OUT, 'cli.js'), '--help'], { encoding: 'utf8' });
if (!help.includes('--format')) throw new Error('El CLI embebido no responde a --help como se esperaba.');

const files = walk(OUT).length;
console.log(`CLI embebido en ${relative(ROOT, OUT)}/ · ${files} archivos · src ${srcHash}`);

// 6. Empaquetado opcional: un .zip con la carpeta del skill como única entrada
//    de primer nivel, que es lo que esperan tanto claude.ai como --plugin-dir.
if (pack) {
  const zip = join(ROOT, 'isams-boletin-skill.zip');
  rmSync(zip, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', zip, 'isams-boletin', '-x', '*.DS_Store'], {
    cwd: dirname(SKILL),
    stdio: 'inherit',
  });
  const kb = Math.round(statSync(zip).size / 1024);
  console.log(`Empaquetado ${relative(ROOT, zip)} · ${kb} KB`);
}
