// smoke-install.mjs
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), '../..'); // repo root
const consumer = resolve(root, 'smoke/smoke-consumer');
const packedDir = resolve(consumer, '_packed');
const pkgs = [
  { name: '@firebase-bridge/firestore-admin', path: resolve(root, 'packages/firestore-admin'), outFile: 'firestore-admin.tgz' },
  { name: '@firebase-bridge/firestore-functions', path: resolve(root, 'packages/firestore-functions'), outFile: 'firestore-functions.tgz' },
];

function sh(cmd, cwd = root) {
  console.log('$', cmd, '(cwd:', cwd, ')');
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function cleanTgz(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.tgz')) unlinkSync(resolve(dir, f));
  }
}

/**
 * Build a package and `npm pack` it *into* the shared _packed/ folder.
 * Returns the absolute path of the generated tarball within `_packed/`.
 */
function packIntoPacked(pkgDir) {
  // Ensure package is built first
  sh('npm run build', pkgDir);

  // Run `npm pack` from _packed/, targeting the built dist/ folder.
  const dist = resolve(pkgDir, 'dist');
  mkdirSync(packedDir, { recursive: true });
  const out = execSync(`npm pack --json "${dist}"`, { cwd: packedDir }).toString();
  const [{ filename }] = JSON.parse(out);
  return resolve(packedDir, filename); // e.g. firebase-bridge-firestore-admin-0.0.1.tgz
}

function main() {
  // Only delete existing tarballs in _packed/ (keep the directory itself)
  cleanTgz(packedDir);

  // Pack each package directly into _packed/
  pkgs.map((p) => {
    const generated = packIntoPacked(p.path);
    const target = resolve(packedDir, p.outFile);
    // Normalize filename to a stable alias (e.g., firestore-admin.tgz)
    // If target exists (from a previous run), remove it first
    try { unlinkSync(target); } catch {
      // no-op
    }
    renameSync(generated, target);
    return { p, tgz: target };
  });

  // Fresh install in consumer from tarballs
  rmSync(resolve(consumer, 'node_modules'), { recursive: true, force: true });
  rmSync(resolve(consumer, 'package-lock.json'), { force: true });

  // Point installs at local tarballs via npm aliases
  sh(
    'npm i ./_packed/firestore-admin.tgz ./_packed/firestore-functions.tgz',
    consumer
  );

  const tarballFilenames = ['firestore-admin.tgz', 'firestore-functions.tgz'];

  // Quick packaging sanity checks (best-effort)
  tarballFilenames.forEach((filename) => {
    try { sh(`npx publint ./_packed/${filename}`, consumer); } catch {
      // no-op
    }
  });
  tarballFilenames.forEach((filename) => {
    try { sh(`npx attw ./_packed/${filename}`, consumer); } catch {
      // no-op
    }
  });

  // Build all relevant projects for both formats (assumes a "build:both" target exists)
  sh('npx nx run-many -t "build:both" --all');

  // Run smoke tests
  sh('npm test', consumer);
  console.log('✅ Smoke complete');
}

main();
