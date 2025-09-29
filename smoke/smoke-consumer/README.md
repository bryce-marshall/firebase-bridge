# smoke-consumer — Local README

## What this is

A minimal app that **consumes** the locally built `@firebase-bridge` packages. It packs them from `dist/`, installs the tarballs here, runs published‑shape checks, and verifies **CJS** + **ESM** execution and TypeScript type‑checks.

---

## Quick start

From the **workspace root**:

```bash
npx nx run smoke-consumer:smoke
```

Expected output: publint “All good!”, attw green (or noted warnings), `CJS ok …`, `ESM ok …`, TS checks pass, and `✅ Smoke complete`.

Optional—run the built entrypoints:

```bash
npx nx run smoke-consumer:exec-cjs
npx nx run smoke-consumer:exec-esm
```

---

## Prerequisites

* Node.js **≥18** (20/22 OK)
* npm **≥9**
* Git
* `npx` will fetch **publint** and **arethetypeswrong** (attw) on demand

---

## Folder layout

```
smoke/
  smoke-consumer/
    scripts/
      smoke-install.mjs   # build → pack → install → lint tarballs → run smoke tests
      rename-cjs.mjs      # optional: rename dist/cjs/main.js → main.cjs
    _packed/              # firestore-*.tgz copied here
    dist/                 # consumer build outputs (esm + cjs)
    package.json          # consumer scripts & Nx targets (exec-cjs, exec-esm)
```

---

## Upstream expectations

Before running the smoke, each package must have built artifacts:

* `packages/firestore-admin/dist/{esm,cjs}/...`
* `packages/firestore-functions/dist/{esm,cjs}/...`
  And each **dist `package.json`** should reference built files only:
* `main` → `./dist/cjs/...`, `module` → `./dist/esm/...`, `types` → `./dist/esm/...d.ts`
* `exports` map resolves to `dist` (no `src/`)

---

## What the smoke script does

`node smoke/smoke-consumer/scripts/smoke-install.mjs`:

1. **Builds** the local packages via Nx.
2. **Packs** each from its `dist` (`npm pack --json`), copies to `_packed/` as `firestore-admin.tgz` / `firestore-functions.tgz`.
3. **Cleans** this app’s `node_modules` and lockfile for a fresh install.
4. **Installs** both tarballs:

   ```bash
   npm i ./_packed/firestore-admin.tgz ./_packed/firestore-functions.tgz
   ```
5. **Lints** tarballs:

   * `publint <tarball>` — published shape
   * `attw --pack <tarball>` — type resolution across Node/bundler conditions
6. **Runs smoke tests** (`npm test`): executes CJS + ESM entrypoints and TS type‑checks (NodeNext + Node16).

---

## Running entrypoints directly (optional)

From this folder:

```bash
node dist/cjs/main.cjs
node dist/esm/main.js
```

---

## Linting tarballs manually

Use absolute paths (avoids Windows/`INIT_CWD` quirks):

```bash
npx publint smoke/smoke-consumer/_packed/firestore-admin.tgz
npx publint smoke/smoke-consumer/_packed/firestore-functions.tgz
npx attw --pack smoke/smoke-consumer/_packed/firestore-admin.tgz
npx attw --pack smoke/smoke-consumer/_packed/firestore-functions.tgz
```

---

## Troubleshooting

* **EUNSUPPORTEDPROTOCOL workspace:*:** A tarball still depends on `workspace:*`. The smoke script rewrites functions to a real semver (e.g. `^0.0.1`). Rebuild/repack if you see this.
* **publint/attw can’t find `.tgz`:** Use absolute tarball paths or ensure `cwd` is `_packed/`.
* **SWC peer warnings:** From this app’s dev tooling—harmless for the smoke.
* **Node treats CJS as ESM:** Rename `dist/cjs/main.js` → `main.cjs` with `scripts/rename-cjs.mjs`, and point any scripts/targets to `.cjs`.
* **TypeScript errors during upstream builds:** Fix in the package projects, then rerun the smoke.

---

## Maintenance

* Keep the rewrite logic in the smoke script in sync with upstream package names/versions/paths.
* Optionally pin the functions → admin dependency to `^<admin-version>` read from admin’s source `package.json` at pack time.
* If upstream packages ship `.cjs` and (optionally) `.d.cts`, you can drop the consumer’s rename helper.

---

## Useful commands (workspace root)

```bash
# Full smoke (build → pack → install → lint → run)
npx nx run smoke-consumer:smoke

# Run already-built entries
npx nx run smoke-consumer:exec-cjs
npx nx run smoke-consumer:exec-esm

# Clean consumer for a fresh install
rimraf smoke/smoke-consumer/node_modules smoke/smoke-consumer/package-lock.json

# Manual tarball checks
npx publint smoke/smoke-consumer/_packed/firestore-admin.tgz
npx attw --pack smoke/smoke-consumer/_packed/firestore-functions.tgz
```

---

## FAQ

**Do I need to publish to npm?** No—this uses local tarballs from `dist/`.

**Why not install via `workspace:*`?** Tarballs installed into another project can’t resolve `workspace:*`. We rewrite to a real semver so both tarballs install together.

**Why test NodeNext and Node16 TS configs?** Many consumers still use Node16 semantics; we ensure types resolve in both.

**Can I run only CJS or only ESM checks?** Yes—use the corresponding Nx target or run the entry directly with Node.
