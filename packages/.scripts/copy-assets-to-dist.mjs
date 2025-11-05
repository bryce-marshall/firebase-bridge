import {
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { resolve } from 'node:path';

export function copyAssetsToDist(projectRoot) {
  const ROOT = resolve(projectRoot);
  const DIST = resolve(ROOT, 'dist');
  const ASSETS = resolve(ROOT, 'assets');
  const THIRD_PARTY_DIR = resolve(ASSETS, 'THIRD_PARTY_LICENSES');

  // ensure folders
  mkdirSync(DIST, { recursive: true });
  mkdirSync(resolve(DIST, 'cjs'), { recursive: true });

  // 1) dist/package.json = assets/package.json + name/version from root
  const rootPkg = JSON.parse(
    readFileSync(resolve(ROOT, 'package.json'), 'utf8')
  );
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
      // no-op if asset does not exist
    }
  }

  // 4) optional: copy assets/THIRD_PARTY_LICENSES -> dist/THIRD_PARTY_LICENSES
  if (existsSync(THIRD_PARTY_DIR)) {
    cpSync(THIRD_PARTY_DIR, resolve(DIST, 'THIRD_PARTY_LICENSES'), {
      recursive: true,
    });
  }
}

// Example (optional):
// copyAssetsToDist('.');
