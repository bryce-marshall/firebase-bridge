// .scripts/dup-types-to-cts.mjs
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function duplicateDtsToCts(projectRoot) {
  const root = resolve(projectRoot);
  const typesRoot = resolve(root, 'dist', 'esm');

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (p.endsWith('.d.ts')) {
        const cts = p.replace(/\.d\.ts$/, '.d.cts');
        writeFileSync(cts, readFileSync(p));
      }
    }
  }

  walk(typesRoot);
  console.log('✓ duplicated .d.ts → .d.cts under dist/esm');
}

// Example usage (from a per-package post-build):
// import { duplicateDtsToCts } from '../../.scripts/dup-types-to-cts.mjs';
// duplicateDtsToCts('.');
