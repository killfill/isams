import { execFileSync } from 'node:child_process';
for (const f of ['e2e.ts', 'pipeline.ts', 'store.ts', 'refresh.ts', 'golden.ts']) {
  console.log(`\n── ${f} ${'─'.repeat(50 - f.length)}`);
  execFileSync('npx', ['tsx', `test/${f}`], { stdio: 'inherit' });
}
