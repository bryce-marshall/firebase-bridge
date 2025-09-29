// smoke/smoke-consumer/scripts/rename-cjs.mjs
import { renameSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..'); // smoke-consumer root

const fromJs = resolve(root, 'dist/cjs/main.js');
const toCjs = resolve(root, 'dist/cjs/main.cjs');
const fromMap = resolve(root, 'dist/cjs/main.js.map');
const toMap = resolve(root, 'dist/cjs/main.cjs.map');

function renameIfExists(src, dest) {
  if (existsSync(src)) {
    renameSync(src, dest);
    console.log(`renamed: ${src} -> ${dest}`);
  } else {
    console.log(`skip (not found): ${src}`);
  }
}

renameIfExists(fromJs, toCjs);
renameIfExists(fromMap, toMap);
