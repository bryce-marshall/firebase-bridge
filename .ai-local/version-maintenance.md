# Version Maintenance

Version maintenance is the set of release-readiness edits that keep this workspace's source package metadata and human-facing package documentation aligned with both the current repo state and the intended published package state.

It covers two related responsibilities:

- Keep local developer documentation and package consumer documentation accurate. For package-facing files, review the relevant `README.md`, `LICENSE`, and `NOTICE` files, especially under `packages/<project>/assets/`, against the code, package metadata, and expected npm package contents.
- Keep package identity and versions consistent between each package project and its publish assets. For every publishable package, compare `packages/<project>/package.json` with `packages/<project>/assets/package.json`; their `name` values must match, and any `version` field present in assets must match the project package version.

## Source Files

Treat these files as the source of truth for version maintenance:

- Root repo documentation such as `README.md` when it describes packages or release state.
- Package project metadata: `packages/<project>/package.json`.
- Package publish assets: `packages/<project>/assets/package.json`, `packages/<project>/assets/README.md`, `packages/<project>/assets/LICENSE`, and `packages/<project>/assets/NOTICE`.

Generated files under `packages/<project>/dist/` can be inspected to understand current build output, but do not edit them as the primary fix. Update source package files or assets, then rebuild when verification requires regenerated output.

## Publish Manifest Behavior

`packages/.scripts/copy-assets-to-dist.mjs` creates `packages/<project>/dist/package.json` from `packages/<project>/assets/package.json`, then copies `name` and `version` from `packages/<project>/package.json`.

Verify that behavior before publishing. The generated `dist/package.json` should have the package project's current `name` and `version`.

Dependency fields are not copied from the project package manifest. Configure `dependencies`, `devDependencies`, and `peerDependencies` explicitly in `packages/<project>/assets/package.json` when they belong in the published package, and check their package names and version ranges against `packages/<project>/package.json` before publication.

## Working Change Logs

During development, agents may maintain a scoped temporary high-level change log below `.docs/.working/changes/`. Use it to capture package-relevant behavior, dependency, API, documentation, licensing, and publish-shape changes while work is still in progress.

When development is complete, use the relevant working change log as a guide for the version-maintenance pass. It can help identify documentation, manifest, license, and notice updates, but it does not replace checking the current source files, package assets, and generated publish output.

## Agent Checklist

When doing version maintenance:

- Identify the package or packages involved before editing.
- Review any relevant temporary change log below `.docs/.working/changes/` for package-facing updates that need to be reflected in manifests or documentation.
- Compare repo-facing docs with package-facing assets and keep each audience-specific, not merely duplicated.
- Check package names, versions, descriptions, entry points, peer dependencies, engines, license metadata, repository metadata, and publish configuration for drift between project and asset package manifests.
- Before publishing, rebuild or inspect `packages/<project>/dist/package.json` to confirm generated `name`, `version`, dependency fields, and peer dependency ranges are correct for consumers.
- Preserve existing public APIs and published package shape unless the task explicitly asks for a breaking change.
- Use minimal, targeted edits and keep generated output separate from source maintenance.
