# Day 17–18 Design: Lockfile Drift Inspector & Private Registry Auto-Detection

Date: 2026-08-09
Status: Approved

## Overview

Implements roadmap Days 17–18 for Slop-Stop:

- **Day 17:** Parse `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`; inspect exact resolved versions; flag manifest↔lockfile drift as `SUSPICIOUS`; verify resolved versions actually exist on the registry.
- **Day 18:** Auto-read `.npmrc`, `pip.conf`/`pip.ini`, `pyproject.toml`; auto-PASS internal scopes; warn (not hard-block) on public-404 packages when a private registry is configured.

## New Dependencies

- `yaml` — pnpm-lock.yaml and yarn.lock (v1 quoted-key and v2+ formats)
- `smol-toml` — poetry.lock and pyproject.toml
- `semver` — semver range satisfaction for drift detection

## New Module: `src/lockfiles.ts`

`parseLockfile(filePath): LockfilePackage[]` where `LockfilePackage = { name: string; version: string }`.

| File | Parser | Notes |
| :--- | :--- | :--- |
| `package-lock.json` | JSON.parse | npm v7+ `packages["node_modules/<name>"].version`; fallback to legacy `dependencies.<name>.version` tree |
| `pnpm-lock.yaml` | `yaml` | Parse `packages:` dict keys: `pkg@1.2.3`, `@scope/pkg@1.2.3`, `registry.npmjs.org/pkg/1.2.3` |
| `yarn.lock` | `yaml` | Entries like `"pkg@^1.0.0":` with `version: "1.2.3"` (v1) or real YAML (v2+) |
| `poetry.lock` | `smol-toml` | `[[package]]` tables → name + version |

Error handling: parse failure returns `[]` (fail open), matching the scanner's try/catch convention.

## New Module: `src/drift.ts`

`checkDrift(dir: string): DriftReport`

- `DriftPackage = { name; manifestRange?; lockfileVersion?; severity: 'PASS' | 'SUSPICIOUS'; reasons: string[] }`
- `DriftReport = { packages: DriftPackage[]; suspiciousCount: number; hallucinationCount: number; durationMs: number }`

Comparison sources:

- Manifest: `package.json` (dependencies, devDependencies, peerDependencies), `pyproject.toml` `[tool.poetry.dependencies]`
- Lockfiles: any of the four supported files in `dir`

Rules:

1. Manifest dep absent from lockfile → `SUSPICIOUS` "Declared in manifest but absent from lockfile"
2. Lockfile version does not satisfy manifest semver range (`semver.satisfies`) → `SUSPICIOUS` "Version drift: manifest ^2.0.0 vs lockfile 1.0.3"
3. Lockfile-only entries (not in manifest) are reported as informational, not suspicious
4. If neither manifest nor lockfile present → empty report

`checkDrift` is synchronous (file-only). The CLI command additionally verifies resolved versions against the registry (see below).

## New Module: `src/registry-config.ts`

Private registry / scope detection, cached per process.

- `loadRegistryConfig(dir): RegistryConfig`
  - `.npmrc`: parse lines `@scope:registry=URL` (scoped mappings) and `registry=URL` (default registry)
  - `pip.conf` / `pip.ini`: `[global] index-url = URL` (and `extra-index-url`)
  - `pyproject.toml`: `[[tool.poetry.source]]` with `name`, `url`, `default`/`secondary`/`priority`; also `[tool.poetry.dependencies]` names
- `isInternal(packageName: string, dir?: string): boolean`
  - Scoped names (`@scope/pkg`): scope is mapped in `.npmrc` → internal
  - Unscoped names: internal if `pip.conf`/`pyproject.toml` defines a private source AND the package is listed in `pyproject.toml` `[tool.poetry.dependencies]` (declared dependency of a private-source project)
- `hasPrivateRegistry(dir): boolean` — true if any private registry/index-url configured. A source counts as **private** when its host differs from the public registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `registry.yarnpkg.com`). Reconfiguring to `https://pypi.org/simple` or `https://registry.npmjs.org` explicitly is not treated as private.

## Registry Exact-Version Validation (`src/registry.ts`)

New exported functions:

- `checkNpmVersion(packageName, version)` → fetches `${NPM_REGISTRY}/${name}/${version}`; 404 = version does not exist
- `checkPyPiVersion(packageName, version)` → fetches `${PYPI_REGISTRY}/${name}/${version}/json`
- Reuses the existing LRU cache (same key scheme, shorter TTL for version checks: 24h)

Lockfile entries with a version that does not exist on the registry are reported as `HALLUCINATION` (hard block, `exit 1`) — catches AI-invented versions like `"express": "999.0.0"`.

## Severity Mapping & Exit Codes

| Condition | Severity | Exit |
| :--- | :--- | :--- |
| Manifest dep missing from lockfile | SUSPICIOUS (soft warn) | 0 |
| Resolved version violates manifest range | SUSPICIOUS (soft warn) | 0 |
| Lockfile version does not exist on registry | HALLUCINATION (hard block) | 1 |
| Package in private scope | PASS (auto) | — |
| Public 404 + private registry configured | SUSPICIOUS (was HALLUCINATION) | 0 |
| Public 404 + no private registry | HALLUCINATION | 1 |

## CLI: `slop-stop check-drift [directory]`

New command. Scans `package.json`/`pyproject.toml` + lockfiles in directory, prints per-package table (name, manifest range, lockfile version, status), then verifies lockfile versions against registry. Summary line with `[ms]` timing, consistent with existing commands.

## Integration Points

1. **`src/config.ts`** — add `isInternal()` passthrough delegating to `registry-config`
2. **`src/index.ts` `check`** — internal-scope auto-PASS before registry check; lockfile files get exact-version verification; 404 + private registry → downgrade to SUSPICIOUS with reason
3. **`src/hook.ts`**
   - `getStagedFiles`: add lockfile basenames (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`)
   - `checkStagedFiles`: lockfile version verification (HALLUCINATION on fake versions); drift detection (SUSPICIOUS soft warn)
4. **`src/watcher.ts`** — add lockfile patterns to `watchPatterns`; internal-scope auto-PASS in `scanFileForWatcher`

The internal-registry check is applied in the same position as the existing `isAllowed` check (before registry call) in `index.ts`, `hook.ts`, and `watcher.ts`.

## Testing

New test suites (vitest, tmp-dir fixtures):

- `src/__tests__/lockfiles.test.ts` — all four formats: real + malformed fixtures, npm v7+ and legacy package-lock trees, pnpm key variants
- `src/__tests__/drift.test.ts` — missing-from-lockfile, range violation, lockfile-only entries, empty project
- `src/__tests__/registry-config.test.ts` — .npmrc scoped + default registry, pip.conf index-url, pyproject.toml sources, isInternal matrix
- `src/__tests__/registry.test.ts` — add version-check tests with mocked fetch (404 vs 200)
- Extend `hook.test.ts` / `cli.test.ts` — staged lockfile handling, drift + fake-version exit codes

Target: 61 → ~85+ passing tests.

## Out of Scope (roadmap Day 19+)

- Shell shims (Day 19)
- `--no-verify` bypass defense (Day 20)
- deps.dev/OSV/Sigstore (Day 21–22)
- Typosquatting/Levenshtein (Day 23)
