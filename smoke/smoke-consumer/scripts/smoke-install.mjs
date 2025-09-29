// smoke-install.mjs
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), '../..'); // repo root
const consumer = resolve(root, 'smoke/smoke-consumer');
const packedDir = resolve(consumer, '_packed');
const pkgs = [
  { name: '@firebase-bridge/firestore-admin', path: resolve(root, 'packages/firestore-admin') },
  { name: '@firebase-bridge/firestore-functions', path: resolve(root, 'packages/firestore-functions') },
];

function sh(cmd, cwd = root) {
  console.log('$', cmd, ' (cwd:', cwd, ')');
  execSync(cmd, {
    cwd,
    stdio: 'inherit',
  });
}

function pack(pkgDir) {
  sh('npm run build', pkgDir);
  // pack from dist
  const dist = resolve(pkgDir, 'dist');
  const out = execSync('npm pack --json', { cwd: dist }).toString();
  const [{ filename }] = JSON.parse(out);
  return resolve(dist, filename);
}

function cleanTgz(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.tgz')) {
      unlinkSync(resolve(dir, f));
    }
  }
}

function main() {
  // Only delete *.tgz inside _packed (keep the directory)
  cleanTgz(packedDir);

  const tarballs = pkgs.map((p) => ({ p, tgz: pack(p.path) }));
  for (const { p, tgz } of tarballs) {
    const target = resolve(packedDir, `${p.name.split('/').pop()}.tgz`);
    copyFileSync(tgz, target);
  }

  // fresh install in consumer from tarballs
  rmSync(resolve(consumer, 'node_modules'), { recursive: true, force: true });
  rmSync(resolve(consumer, 'package-lock.json'), { force: true });

  // point installs at local tarballs via npm aliases
  sh('npm i ./_packed/firestore-admin.tgz ./_packed/firestore-functions.tgz', consumer);

  const tarballFilenames = ['firestore-admin.tgz', 'firestore-functions.tgz'];

  // quick packaging sanity checks
  tarballFilenames.forEach((filename) => {
    try {
      sh(`npx publint ./_packed/${filename}`, consumer);
    } catch {
      // no-op
    }
  });

  tarballFilenames.forEach((filename) => {
    try {
      sh(`npx attw ./_packed/${filename}`, consumer);
    } catch {
      // no-op
    }
  });

  // Build all relevant projects for both formats (assumes a "build:both" target exists)
  sh('npx nx run-many -t "build:both" --all');

  // run smoke tests
  sh('npm test', consumer);
  console.log('✅ Smoke complete');
}

main();
