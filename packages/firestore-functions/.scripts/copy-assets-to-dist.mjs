import { mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve('.');
const DIST = resolve('dist');
const ASSETS = resolve('assets');

// ensure folders
mkdirSync(DIST, { recursive: true });
mkdirSync(resolve(DIST, 'cjs'), { recursive: true });

// 1) dist/package.json = assets/package.json + name/version from root
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const assetsPkg = JSON.parse(
  readFileSync(resolve(ASSETS, 'package.json'), 'utf8')
);
const distPkg = {
  name: rootPkg.name,
  version: rootPkg.version,
  ...assetsPkg,
};
writeFileSync(
  resolve(DIST, 'package.json'),
  JSON.stringify(distPkg, null, 2) + '\n'
);

// 2) cjs/package.json to assert CommonJS semantics under root "type":"module"
cpSync(
  resolve(ASSETS, 'cjs', 'package.json'),
  resolve(DIST, 'cjs', 'package.json')
);

// 3) docs
for (const file of ['README.md', 'NOTICE', 'LICENSE']) {
  try {
    cpSync(resolve(ASSETS, file), resolve(DIST, file), { recursive: false });
  } catch {
    //no-op
  }
}
