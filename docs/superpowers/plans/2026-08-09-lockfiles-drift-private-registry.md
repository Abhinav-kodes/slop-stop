# Lockfile Drift Inspector & Private Registry Auto-Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement roadmap Days 17–18: parse npm/pnpm/yarn/poetry lockfiles, verify exact resolved versions against registries, detect manifest↔lockfile drift, and auto-detect private registries/scopes so internal packages auto-PASS while staying protected.

**Architecture:** Three new pure modules (`src/lockfiles.ts` parser, `src/drift.ts` sync drift + async version verification, `src/registry-config.ts` private-registry detection) plug into the existing pipeline. The existing `check`/`watch`/`check-staged` flows get an internal-scope auto-PASS in the same position as the existing `isAllowed` check, and lockfile files get exact-version verification. A new `check-drift` CLI command reports manifest↔lockfile drift and locked-version existence.

**Tech Stack:** TypeScript 7, Node 20+ (`fetch`, `AbortSignal.timeout`), `yaml`, `smol-toml`, `semver`, vitest 4, existing `lru-cache` + chalk.

## Global Constraints

- Severity vocabulary is exactly `PASS` / `SUSPICIOUS` / `HALLUCINATION` (string literals).
- Public registries = `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `registry.yarnpkg.com`. A source is **private** when its host differs from these — even explicitly configuring `https://pypi.org/simple` or `https://registry.npmjs.org` is NOT private.
- Severity/exit mapping (verbatim from spec):

  | Condition | Severity | Exit |
  | :--- | :--- | :--- |
  | Manifest dep missing from lockfile | SUSPICIOUS (soft warn) | 0 |
  | Resolved version violates manifest range | SUSPICIOUS (soft warn) | 0 |
  | Lockfile version does not exist on registry | HALLUCINATION (hard block) | 1 |
  | Package in private scope | PASS (auto) | — |
  | Public 404 + private registry configured | SUSPICIOUS (was HALLUCINATION) | 0 |
  | Public 404 + no private registry | HALLUCINATION | 1 |
- Downgrade reason copy is exactly `possible internal package — consider scoping` (approved in brainstorming).
- Parse failures **fail open** (return `[]` / empty config), matching the scanner's try/catch convention.
- All computation is synchronous where no network is involved; only registry checks are async.
- Existing test conventions: `fs.mkdtempSync` fixtures under `os.tmpdir()` with `beforeEach`/`afterEach` cleanup, `execSync('git init', ...)` + `git config user.name/email` for staged tests, `quiet: true` option to silence output, plain `describe`/`it`/`expect` imports from `vitest`.
- Commands: `npm test` (vitest run), `npx vitest run <file>` (single suite), `npx tsc --noEmit` (typecheck), `npm run build` (tsc emit to `dist/`).
- Commit after every green task; see each task for exact `git add` lists.

---

### Task 1: Dependencies + `src/lockfiles.ts` — parse all four lockfile formats

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/lockfiles.ts`
- Create: `src/__tests__/lockfiles.test.ts`

**Interfaces (produces):** later tasks rely on exactly these names/shapes.
- `export interface LockfilePackage { name: string; version: string }`
- `export const LOCKFILE_BASENAMES: string[]` — `['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock']`
- `export function isLockfile(filePath: string): boolean`
- `export function lockfileRegistryType(filePath: string): 'npm' | 'pypi'` — `poetry.lock` → `'pypi'`, everything else → `'npm'`
- `export function parseLockfile(filePath: string): LockfilePackage[]` — basename dispatcher; any read/parse failure → `[]`

Notes from parser probing (verified against real `yaml`/`smol-toml` behavior):
- Yarn v1 lockfiles contain multi-key lines like `"pkg@^1.0.0", "pkg@^1.0.1":` which are NOT valid YAML (`yaml` throws). Expand them into one key line per quoted selector before parsing (body duplicated for each key — that is the correct resolution).
- pnpm v9 keys: `lodash@4.17.21`, `@scope/pkg@1.2.3`, `registry.npmjs.org/debug/4.3.4` — all parse with `yaml`; versions may carry `_` or `(...)` suffixes, which must be stripped.
- `semver.satisfies('1.0.3', 'not-a-range')` does NOT throw — it returns `false`; guard ranges/versions with `validRange`/`valid` (Task 4).

- [ ] **Step 1: Install the dependencies**

```bash
npm install yaml@2 smol-toml semver
npm install -D @types/semver
```

Verify: `yaml`, `smol-toml`, `semver` under `dependencies`; `@types/semver` under `devDependencies` in `package.json`.

- [ ] **Step 2: Write the failing tests**

Create `src/__tests__/lockfiles.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseLockfile, isLockfile, lockfileRegistryType, LOCKFILE_BASENAMES } from '../lockfiles';

describe('lockfiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-lockfiles-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(name: string, contents: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  function sortedNames(packages: Array<{ name: string; version: string }>): string[] {
    return packages.map((p) => p.name).sort();
  }

  it('isLockfile recognizes the four lockfile basenames only', () => {
    for (const base of LOCKFILE_BASENAMES) {
      expect(isLockfile(base)).toBe(true);
    }
    expect(isLockfile('package.json')).toBe(false);
    expect(isLockfile('/some/dir/yarn.lock')).toBe(true);
  });

  it('lockfileRegistryType maps poetry.lock to pypi, others to npm', () => {
    expect(lockfileRegistryType('poetry.lock')).toBe('pypi');
    expect(lockfileRegistryType('package-lock.json')).toBe('npm');
    expect(lockfileRegistryType('pnpm-lock.yaml')).toBe('npm');
    expect(lockfileRegistryType('yarn.lock')).toBe('npm');
  });

  it('parses npm v7+ package-lock.json', () => {
    const filePath = writeFixture('package-lock.json', JSON.stringify({
      name: 'demo', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/express': { version: '4.19.2' },
        'node_modules/@babel/core': { version: '7.24.0' },
        'node_modules/express/node_modules/accepts': { version: '1.3.8' },
      },
    }));
    const result = parseLockfile(filePath);
    expect(sortedNames(result)).toEqual(['@babel/core', 'accepts', 'express']);
    expect(result.find((p) => p.name === 'express')?.version).toBe('4.19.2');
    expect(result.find((p) => p.name === '@babel/core')?.version).toBe('7.24.0');
  });

  it('parses legacy npm v5/v6 package-lock.json dependencies tree', () => {
    const filePath = writeFixture('package-lock.json', JSON.stringify({
      name: 'root', version: '1.0.0', lockfileVersion: 1,
      dependencies: {
        express: { version: '4.19.2', dependencies: { accepts: { version: '1.3.0' } } },
      },
    }));
    const result = parseLockfile(filePath);
    expect(sortedNames(result)).toEqual(['accepts', 'express']);
  });

  it('parses pnpm-lock.yaml key variants', () => {
    const filePath = writeFixture('pnpm-lock.yaml', [
      'lockfileVersion: "9.0"',
      'packages:',
      '  lodash@4.17.21:',
      '    resolution: {integrity: "sha512-xxx"}',
      '  "@scope/pkg@1.2.3":',
      '    resolution: {integrity: "sha512-yyy"}',
      '  registry.npmjs.org/debug/4.3.4:',
      '    resolution: {integrity: "sha512-zzz"}',
      '',
    ].join('\n'));
    const result = parseLockfile(filePath);
    expect(sortedNames(result)).toEqual(['@scope/pkg', 'debug', 'lodash']);
    expect(result.find((p) => p.name === 'debug')?.version).toBe('4.3.4');
  });

  it('parses yarn.lock v1 including multi-key entries', () => {
    const filePath = writeFixture('yarn.lock', [
      '# yarn lockfile v1',
      '"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.24.0":',
      '  version "7.24.17"',
      '  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.24.17.tgz"',
      '"lodash@^4.17.21":',
      '  version "4.17.21"',
      '',
    ].join('\n'));
    const result = parseLockfile(filePath);
    expect(sortedNames(result)).toEqual(['@babel/code-frame', 'lodash']);
    expect(result.find((p) => p.name === '@babel/code-frame')?.version).toBe('7.24.17');
  });

  it('parses yarn.lock v2+ YAML format', () => {
    const filePath = writeFixture('yarn.lock', [
      '__metadata:',
      '  version: 8',
      '  cacheKey: 10c0',
      '"pkg@npm:^1.0.0":',
      '  version: 1.2.3',
      '  resolution: "pkg@npm:1.2.3"',
      '',
    ].join('\n'));
    const result = parseLockfile(filePath);
    expect(result).toEqual([{ name: 'pkg', version: '1.2.3' }]);
  });

  it('parses poetry.lock', () => {
    const filePath = writeFixture('poetry.lock', [
      '[[package]]',
      'name = "requests"',
      'version = "2.31.0"',
      '',
      '[[package]]',
      'name = "colorama"',
      'version = "0.4.6"',
      '',
    ].join('\n'));
    const result = parseLockfile(filePath);
    expect(sortedNames(result)).toEqual(['colorama', 'requests']);
  });

  it('returns [] for malformed files (fail open)', () => {
    const malformedJson = writeFixture('package-lock.json', '{ not valid json ');
    expect(parseLockfile(malformedJson)).toEqual([]);

    const malformedYaml = writeFixture('pnpm-lock.yaml', 'packages: [unclosed');
    expect(parseLockfile(malformedYaml)).toEqual([]);

    const malformedToml = writeFixture('poetry.lock', '[[package]\nname = broken');
    expect(parseLockfile(malformedToml)).toEqual([]);
  });

  it('returns [] for missing files and unsupported basenames', () => {
    expect(parseLockfile(path.join(tmpDir, 'missing.lock'))).toEqual([]);
    expect(parseLockfile(path.join(tmpDir, 'package.json'))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/lockfiles.test.ts`
Expected: FAIL — module `../lockfiles` not found.

- [ ] **Step 4: Implement `src/lockfiles.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';

export interface LockfilePackage {
  name: string;
  version: string;
}

export const LOCKFILE_BASENAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
];

export function isLockfile(filePath: string): boolean {
  return LOCKFILE_BASENAMES.includes(path.basename(filePath));
}

export function lockfileRegistryType(filePath: string): 'npm' | 'pypi' {
  return path.basename(filePath) === 'poetry.lock' ? 'pypi' : 'npm';
}

export function parseLockfile(filePath: string): LockfilePackage[] {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    switch (path.basename(filePath)) {
      case 'package-lock.json':
        return parseNpmLock(contents);
      case 'pnpm-lock.yaml':
        return parsePnpmLock(contents);
      case 'yarn.lock':
        return parseYarnLock(contents);
      case 'poetry.lock':
        return parsePoetryLock(contents);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function parseNpmLock(contents: string): LockfilePackage[] {
  const json = JSON.parse(contents) as Record<string, unknown>;
  const packages: LockfilePackage[] = [];

  const tree = json.packages as Record<string, { version?: unknown }> | undefined;
  if (tree && typeof tree === 'object') {
    for (const [key, entry] of Object.entries(tree)) {
      const match = key.match(/^node_modules\/(@[^/]+\/[^/]+|[^/]+)$/);
      if (!match || typeof entry !== 'object' || entry === null) continue;
      const version = (entry as { version?: unknown }).version;
      if (typeof version === 'string') {
        packages.push({ name: match[1], version });
      }
    }
    return packages;
  }

  const walk = (deps: Record<string, unknown>): void => {
    for (const [name, entry] of Object.entries(deps)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const version = (entry as { version?: unknown }).version;
      if (typeof version === 'string') {
        packages.push({ name, version });
      }
      const nested = (entry as { dependencies?: Record<string, unknown> }).dependencies;
      if (nested && typeof nested === 'object') {
        walk(nested);
      }
    }
  };
  const dependencies = json.dependencies as Record<string, unknown> | undefined;
  if (dependencies && typeof dependencies === 'object') {
    walk(dependencies);
  }
  return packages;
}

function stripPnpmSuffix(version: string): string {
  return version.split('(')[0].split('_')[0];
}

function parsePnpmKey(key: string): LockfilePackage | null {
  const urlMatch = key.match(/^https?:\/\/[^/]+\/(@[^/]+\/[^/]+|[^/]+)\/([^/]+)$/);
  if (urlMatch) {
    return { name: urlMatch[1], version: urlMatch[2] };
  }
  const scoped = key.match(/^(@[^@]+\/[^@/]+)@(.+)$/);
  if (scoped) {
    return { name: scoped[1], version: stripPnpmSuffix(scoped[2]) };
  }
  const unscoped = key.match(/^([^@/]+)@(.+)$/);
  if (unscoped) {
    return { name: unscoped[1], version: stripPnpmSuffix(unscoped[2]) };
  }
  return null;
}

function parsePnpmLock(contents: string): LockfilePackage[] {
  const doc = parseYaml(contents) as { packages?: Record<string, unknown> } | null;
  if (!doc || typeof doc.packages !== 'object' || doc.packages === null) {
    return [];
  }
  const packages: LockfilePackage[] = [];
  for (const key of Object.keys(doc.packages)) {
    const pkg = parsePnpmKey(key);
    if (pkg) packages.push(pkg);
  }
  return packages;
}

function yarnNameFromKey(key: string): string {
  if (key.startsWith('@')) {
    const at = key.indexOf('@', 1);
    return at === -1 ? key : key.slice(0, at);
  }
  return key.split('@')[0];
}

function expandYarnMultiKeys(contents: string): string {
  const lines: string[] = [];
  for (const line of contents.split('\n')) {
    const multi = line.match(/^((?:"[^"]*")(?:\s*,\s*"[^"]*")+):$/);
    if (!multi) {
      lines.push(line);
      continue;
    }
    const keys = multi[1].match(/"[^"]*"/g);
    if (!keys) {
      lines.push(line);
      continue;
    }
    for (const key of keys) {
      lines.push(`${key}:`);
    }
  }
  return lines.join('\n');
}

function parseYarnLock(contents: string): LockfilePackage[] {
  const expanded = expandYarnMultiKeys(contents);
  const doc = parseYaml(expanded) as Record<string, { version?: unknown }> | null;
  if (!doc || typeof doc !== 'object') {
    return [];
  }
  const packages: LockfilePackage[] = [];
  for (const [key, entry] of Object.entries(doc)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const version = (entry as { version?: unknown }).version;
    if (typeof version !== 'string' && typeof version !== 'number') continue;
    packages.push({ name: yarnNameFromKey(key), version: String(version) });
  }
  return packages;
}

function parsePoetryLock(contents: string): LockfilePackage[] {
  const doc = parseToml(contents) as { package?: Array<{ name?: unknown; version?: unknown }> } | null;
  if (!doc || !Array.isArray(doc.package)) {
    return [];
  }
  const packages: LockfilePackage[] = [];
  for (const entry of doc.package) {
    if (typeof entry.name === 'string' && typeof entry.version === 'string') {
      packages.push({ name: entry.name, version: entry.version });
    }
  }
  return packages;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all lockfiles tests green; existing 61 tests still pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lockfiles.ts src/__tests__/lockfiles.test.ts
git commit -m "feat: parse package-lock.json, pnpm-lock.yaml, yarn.lock, poetry.lock"
```

---

### Task 2: Registry exact-version validation (`src/registry.ts`)

**Files:**
- Modify: `src/registry.ts`
- Modify: `src/__tests__/registry.test.ts`

**Interfaces (produces):**
- `export function checkPackageVersion(packageName: string, version: string, registry: 'npm' | 'pypi'): Promise<PackageCheckResult>` — 404 → `{ exists: false }`; 200 → `{ exists: true, data }`; fetch error → `{ exists: false, error }` with `console.warn` (fail open, same convention as package checks).

Reuses the existing module-level LRU `cache` (new key scheme `` `${registry}:${name}:${version}` ``; TTL 24h for both 200 and 404; `REGISTRY_DOWN` entries are never written here, only regular results). Batch concurrency of 10 is handled by the caller in Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/registry.test.ts` (append a new describe block):

```ts
import { checkPackageVersion } from '../registry';
import { vi } from 'vitest';

describe('registry exact-version validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exists:false when the version 404s', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 404,
      json: async () => ({}),
    } as Response);

    const result = await checkPackageVersion('foo', '999.0.0', 'npm');
    expect(result.exists).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns exists:true with data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      json: async () => ({ name: 'foo', version: '1.0.0' }),
    } as Response);

    const result = await checkPackageVersion('foo', '1.0.0', 'npm');
    expect(result.exists).toBe(true);
    expect(result.data).toEqual({ name: 'foo', version: '1.0.0' });
  });

  it('builds pypi version URLs as /pypi/<name>/<version>/json', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      json: async () => ({}),
    } as Response);

    await checkPackageVersion('requests', '2.31.0', 'pypi');
    const url = (fetchSpy.mock.calls[0][0] as string);
    expect(url).toBe('https://pypi.org/pypi/requests/2.31.0/json');
  });

  it('fails open with error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await checkPackageVersion('foo', '1.0.0', 'npm');
    expect(result.exists).toBe(false);
    expect(result.error).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/registry.test.ts`
Expected: FAIL — `checkPackageVersion is not a function`.

- [ ] **Step 3: Implement in `src/registry.ts`**

Append to `src/registry.ts` (keep all existing code unchanged):

```ts
const VERSION_CACHE_TTL = 1000 * 60 * 60 * 24;

async function checkRegistryVersion(
  packageName: string,
  version: string,
  registry: string,
  url: string,
): Promise<PackageCheckResult> {
  const key = cacheKey(packageName, `${registry}:version`);
  const versionKey = `${key}@${version}`;
  const cached = cache.get(versionKey);
  if (cached && cached !== 'REGISTRY_DOWN') {
    return cached;
  }

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    let result: PackageCheckResult;
    if (response.status === 404) {
      result = { packageName, exists: false };
    } else if (response.status === 200) {
      const data = await response.json();
      result = { packageName, exists: true, data };
    } else {
      result = {
        packageName,
        exists: false,
        error: `Unexpected status: ${response.status}`,
      };
    }

    cache.set(versionKey, result, { ttl: VERSION_CACHE_TTL });
    return result;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.warn(`Registry timeout for ${packageName}@${version}, failing open`);
    } else {
      console.warn(`Registry error for ${packageName}@${version}: ${err.message}`);
    }
    return { packageName, exists: false, error: err.message };
  }
}

export function checkPackageVersion(
  packageName: string,
  version: string,
  registry: 'npm' | 'pypi',
): Promise<PackageCheckResult> {
  const encoded = encodeURIComponent(packageName);
  const encodedVersion = encodeURIComponent(version);
  if (registry === 'pypi') {
    return checkRegistryVersion(
      packageName,
      version,
      PYPI_REGISTRY,
      `${PYPI_REGISTRY}/${encoded}/${encodedVersion}/json`,
    );
  }
  return checkRegistryVersion(
    packageName,
    version,
    NPM_REGISTRY,
    `${NPM_REGISTRY}/${encoded}/${encodedVersion}`,
  );
}
```

Note: the design spec named `checkNpmVersion`/`checkPyPiVersion`; this plan merges them into one `checkPackageVersion` — Task 4 and all later tasks use the merged function, so no other call site references the spec's split names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — registry suite (existing + 4 new) green.

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts src/__tests__/registry.test.ts
git commit -m "feat: verify exact resolved versions against npm/PyPI registries"
```

---

### Task 3: Private registry & scope detection (`src/registry-config.ts`)

**Files:**
- Create: `src/registry-config.ts`
- Create: `src/__tests__/registry-config.test.ts`

**Interfaces (produces):**
- `export interface RegistryConfig { npmScopeRegistry: Map<string,string>; npmRegistryUrl?: string; pipIndexUrls: string[]; pyprojectSources: Array<{ name: string; url: string }>; poetryDependencies: string[] }`
- `export function loadRegistryConfig(dir?: string): RegistryConfig` — per-process cache keyed by resolved dir
- `export function resetRegistryConfigCache(): void` — test hook
- `export function isInternal(packageName: string, dir?: string): boolean`
- `export function hasPrivateRegistry(dir?: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/registry-config.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadRegistryConfig,
  resetRegistryConfigCache,
  isInternal,
  hasPrivateRegistry,
} from '../registry-config';

describe('registry-config private registry detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-regcfg-'));
    resetRegistryConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRegistryConfigCache();
  });

  function write(name: string, contents: string): void {
    fs.writeFileSync(path.join(tmpDir, name), contents);
  }

  it('returns empty config when no private-registry files exist', () => {
    const config = loadRegistryConfig(tmpDir);
    expect(config.npmScopeRegistry.size).toBe(0);
    expect(config.npmRegistryUrl).toBeUndefined();
    expect(config.pipIndexUrls).toEqual([]);
    expect(config.pyprojectSources).toEqual([]);
    expect(config.poetryDependencies).toEqual([]);
  });

  it('parses .npmrc scoped and default registries', () => {
    write('.npmrc', [
      'registry=https://registry.npmjs.org',
      '@mycompany:registry=https://npm.mycompany.com',
      '@other:registry=http://localhost:4873',
      '',
    ].join('\n'));
    const config = loadRegistryConfig(tmpDir);
    expect(config.npmScopeRegistry.get('@mycompany')).toBe('https://npm.mycompany.com');
    expect(config.npmScopeRegistry.get('@other')).toBe('http://localhost:4873');
    expect(config.npmRegistryUrl).toBe('https://registry.npmjs.org');
  });

  it('parses pip.conf global index-url and extra-index-url', () => {
    write('pip.conf', [
      '[global]',
      'index-url = https://artifactory.internal/pypi/simple',
      'extra-index-url = https://pypi.org/simple',
      '',
    ].join('\n'));
    const config = loadRegistryConfig(tmpDir);
    expect(config.pipIndexUrls).toEqual([
      'https://artifactory.internal/pypi/simple',
      'https://pypi.org/simple',
    ]);
  });

  it('parses pip.ini as well', () => {
    write('pip.ini', '[global]\nindex-url = https://mirror.example.com/simple\n');
    expect(loadRegistryConfig(tmpDir).pipIndexUrls).toEqual(['https://mirror.example.com/simple']);
  });

  it('parses pyproject.toml poetry sources and dependencies', () => {
    write('pyproject.toml', [
      '[tool.poetry]',
      'name = "demo"',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'requests = "^2.31.0"',
      'internal-lib = { version = "^1.0.0", source = "internal" }',
      '',
      '[[tool.poetry.source]]',
      'name = "internal"',
      'url = "https://artifactory.example/pypi"',
      'priority = "primary"',
      '',
    ].join('\n'));
    const config = loadRegistryConfig(tmpDir);
    expect(config.pyprojectSources).toEqual([{ name: 'internal', url: 'https://artifactory.example/pypi' }]);
    expect(config.poetryDependencies).toContain('requests');
    expect(config.poetryDependencies).toContain('internal-lib');
    expect(config.poetryDependencies).not.toContain('python');
  });

  describe('hasPrivateRegistry', () => {
    it('false when only public registries are configured', () => {
      write('.npmrc', 'registry=https://registry.npmjs.org\n');
      expect(hasPrivateRegistry(tmpDir)).toBe(false);
    });

    it('true when a scoped registry points at a private host', () => {
      write('.npmrc', '@acme:registry=https://npm.acme.io\n');
      expect(hasPrivateRegistry(tmpDir)).toBe(true);
    });

    it('true when pip index-url host is not pypi.org', () => {
      write('pip.conf', '[global]\nindex-url = https://artifactory.example/simple\n');
      expect(hasPrivateRegistry(tmpDir)).toBe(true);
    });

    it('false when pip index-url is pypi.org explicitly', () => {
      write('pip.conf', '[global]\nindex-url = https://pypi.org/simple\n');
      expect(hasPrivateRegistry(tmpDir)).toBe(false);
    });

    it('true when pyproject.toml defines a private poetry source', () => {
      write('pyproject.toml', '[[tool.poetry.source]]\nname = "internal"\nurl = "https://artifactory.example/pypi"\n');
      expect(hasPrivateRegistry(tmpDir)).toBe(true);
    });
  });

  describe('isInternal', () => {
    it('auto-passes scoped names whose scope is mapped in .npmrc', () => {
      write('.npmrc', '@mycompany:registry=https://npm.mycompany.com\n');
      expect(isInternal('@mycompany/design-system', tmpDir)).toBe(true);
      expect(isInternal('@other/package', tmpDir)).toBe(false);
      expect(isInternal('express', tmpDir)).toBe(false);
    });

    it('auto-passes unscoped names declared in a private-source pyproject', () => {
      write('pyproject.toml', [
        '[tool.poetry.dependencies]',
        'internal-lib = "^1.0.0"',
        '',
        '[[tool.poetry.source]]',
        'name = "internal"',
        'url = "https://artifactory.example/pypi"',
        '',
      ].join('\n'));
      expect(isInternal('internal-lib', tmpDir)).toBe(true);
      expect(isInternal('requests', tmpDir)).toBe(false);
    });

    it('unscoped names are not internal when only a pip index is configured', () => {
      write('pip.conf', '[global]\nindex-url = https://artifactory.example/simple\n');
      expect(isInternal('any-name', tmpDir)).toBe(false);
    });

    it('false when nothing is configured', () => {
      expect(isInternal('anything', tmpDir)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/registry-config.test.ts`
Expected: FAIL — module `../registry-config` not found.

- [ ] **Step 3: Implement `src/registry-config.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';

export interface RegistryConfig {
  npmScopeRegistry: Map<string, string>;
  npmRegistryUrl?: string;
  pipIndexUrls: string[];
  pyprojectSources: Array<{ name: string; url: string }>;
  poetryDependencies: string[];
}

const PUBLIC_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'registry.yarnpkg.com',
];

let cachedDir: string | null = null;
let cachedConfig: RegistryConfig | null = null;

export function resetRegistryConfigCache(): void {
  cachedDir = null;
  cachedConfig = null;
}

export function loadRegistryConfig(dir: string = process.cwd()): RegistryConfig {
  const resolved = path.resolve(dir);
  if (cachedDir === resolved && cachedConfig !== null) {
    return cachedConfig;
  }
  const config = readRegistryConfig(resolved);
  cachedDir = resolved;
  cachedConfig = config;
  return config;
}

function readRegistryConfig(dir: string): RegistryConfig {
  const config: RegistryConfig = {
    npmScopeRegistry: new Map(),
    pipIndexUrls: [],
    pyprojectSources: [],
    poetryDependencies: [],
  };
  readNpmrc(dir, config);
  readPipConf(dir, config);
  readPyproject(dir, config);
  return config;
}

function readNpmrc(dir: string, config: RegistryConfig): void {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(dir, '.npmrc'), 'utf-8');
  } catch {
    return;
  }
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.endsWith(':registry')) {
      config.npmScopeRegistry.set(key.slice(0, -':registry'.length), value);
    } else if (key === 'registry') {
      config.npmRegistryUrl = value;
    }
  }
}

function readPipConf(dir: string, config: RegistryConfig): void {
  for (const filename of ['pip.conf', 'pip.ini']) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(dir, filename), 'utf-8');
    } catch {
      continue;
    }
    let section = '';
    for (const rawLine of contents.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const sectionMatch = line.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        section = sectionMatch[1];
        continue;
      }
      if (section !== 'global') continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'index-url') {
        config.pipIndexUrls.push(value);
      } else if (key === 'extra-index-url') {
        config.pipIndexUrls.push(...value.split(/\s+/).filter(Boolean));
      }
    }
  }
}

function readPyproject(dir: string, config: RegistryConfig): void {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf-8');
  } catch {
    return;
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(contents) as Record<string, unknown>;
  } catch {
    return;
  }
  const tool = (doc.tool ?? {}) as Record<string, unknown>;
  const poetry = (tool.poetry ?? {}) as Record<string, unknown>;
  const source = poetry.source;
  if (Array.isArray(source)) {
    for (const entry of source as Array<Record<string, unknown>>) {
      if (typeof entry.url === 'string') {
        config.pyprojectSources.push({ name: String(entry.name ?? ''), url: entry.url });
      }
    }
  }
  const dependencies = poetry.dependencies;
  if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    for (const name of Object.keys(dependencies)) {
      if (name !== 'python') {
        config.poetryDependencies.push(name);
      }
    }
  }
}

function isPrivateUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return !PUBLIC_REGISTRY_HOSTS.includes(host);
  } catch {
    return false;
  }
}

export function hasPrivateRegistry(dir: string = process.cwd()): boolean {
  const config = loadRegistryConfig(dir);
  if (config.npmRegistryUrl && isPrivateUrl(config.npmRegistryUrl)) {
    return true;
  }
  for (const url of config.npmScopeRegistry.values()) {
    if (isPrivateUrl(url)) return true;
  }
  if (config.pipIndexUrls.some(isPrivateUrl)) {
    return true;
  }
  return config.pyprojectSources.some((source) => isPrivateUrl(source.url));
}

export function isInternal(packageName: string, dir: string = process.cwd()): boolean {
  const config = loadRegistryConfig(dir);
  if (packageName.startsWith('@')) {
    const scope = packageName.slice(0, packageName.indexOf('/'));
    return config.npmScopeRegistry.has(scope);
  }
  const hasPrivatePy =
    config.pipIndexUrls.some(isPrivateUrl) ||
    config.pyprojectSources.some((source) => isPrivateUrl(source.url));
  return hasPrivatePy && config.poetryDependencies.includes(packageName);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/__tests__/registry-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry-config.ts src/__tests__/registry-config.test.ts
git commit -m "feat: auto-detect private registries and internal scopes from .npmrc/pip.conf/pyproject.toml"
```

---

### Task 4: Drift detection + lockfile version verification (`src/drift.ts`)

**Files:**
- Create: `src/drift.ts`
- Create: `src/__tests__/drift.test.ts`

**Interfaces (consumes):**
- Task 1: `parseLockfile`, `LockfilePackage`
- Task 2: `checkPackageVersion`, `PackageCheckResult`
- Task 3: `hasPrivateRegistry`

**Interfaces (produces):**
- `export interface DriftPackage { name: string; manifestRange?: string; lockfileVersion?: string; severity: 'PASS' | 'SUSPICIOUS'; reasons: string[] }`
- `export interface DriftReport { packages: DriftPackage[]; suspiciousCount: number; hallucinationCount: number; durationMs: number }`
- `export function checkDrift(dir: string): DriftReport` — synchronous, no network
- `export interface LockfileVersionCheck { packageName: string; version: string; exists: boolean; severity: 'PASS' | 'SUSPICIOUS' | 'HALLUCINATION'; reasons: string[] }`
- `export function verifyLockfileVersions(filePath: string, dir?: string): Promise<LockfileVersionCheck[]>` — batches of 10, `dir` defaults to `path.dirname(filePath)`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/drift.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkDrift, verifyLockfileVersions } from '../drift';

describe('drift', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-drift-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(name: string, contents: string): void {
    fs.writeFileSync(path.join(tmpDir, name), contents);
  }

  describe('checkDrift', () => {
    it('returns empty report when neither manifest nor lockfile exists', () => {
      const report = checkDrift(tmpDir);
      expect(report.packages).toEqual([]);
      expect(report.suspiciousCount).toBe(0);
    });

    it('flags manifest deps absent from the lockfile as SUSPICIOUS', () => {
      write('package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
      write('package-lock.json', JSON.stringify({
        packages: { 'node_modules/lodash': { version: '4.17.21' } },
      }));
      const report = checkDrift(tmpDir);
      const express = report.packages.find((p) => p.name === 'express');
      expect(express?.severity).toBe('SUSPICIOUS');
      expect(express?.reasons[0]).toContain('absent from lockfile');
      expect(report.suspiciousCount).toBe(1);
    });

    it('flags lockfile version violating the manifest range as SUSPICIOUS', () => {
      write('package.json', JSON.stringify({ dependencies: { express: '^2.0.0' } }));
      write('package-lock.json', JSON.stringify({
        packages: { 'node_modules/express': { version: '1.0.3' } },
      }));
      const report = checkDrift(tmpDir);
      const express = report.packages.find((p) => p.name === 'express');
      expect(express?.severity).toBe('SUSPICIOUS');
      expect(express?.reasons[0]).toContain('Version drift');
    });

    it('PASSES packages that satisfy their range', () => {
      write('package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
      write('package-lock.json', JSON.stringify({
        packages: { 'node_modules/express': { version: '4.19.2' } },
      }));
      const report = checkDrift(tmpDir);
      expect(report.packages.find((p) => p.name === 'express')?.severity).toBe('PASS');
      expect(report.suspiciousCount).toBe(0);
    });

    it('reports lockfile-only entries as informational, not suspicious', () => {
      write('package.json', JSON.stringify({ dependencies: {} }));
      write('package-lock.json', JSON.stringify({
        packages: { 'node_modules/lodash': { version: '4.17.21' } },
      }));
      const report = checkDrift(tmpDir);
      const lodash = report.packages.find((p) => p.name === 'lodash');
      expect(lodash?.severity).toBe('PASS');
      expect(report.suspiciousCount).toBe(0);
    });

    it('checks pyproject.toml manifests against poetry.lock', () => {
      write('pyproject.toml', '[tool.poetry.dependencies]\nrequests = "^2.0.0"\n');
      write('poetry.lock', '[[package]]\nname = "requests"\nversion = "1.0.0"\n');
      const report = checkDrift(tmpDir);
      expect(report.packages.find((p) => p.name === 'requests')?.severity).toBe('SUSPICIOUS');
    });

    it('ignores non-semver ranges and versions instead of flagging them', () => {
      write('package.json', JSON.stringify({ dependencies: { local: 'file:../local' } }));
      write('package-lock.json', JSON.stringify({
        packages: { 'node_modules/local': { version: '0.0.0-use.local' } },
      }));
      const report = checkDrift(tmpDir);
      expect(report.suspiciousCount).toBe(0);
    });
  });

  describe('verifyLockfileVersions', () => {
    it('returns PASS for versions that exist, HALLUCINATION for 404', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ status: 200, json: async () => ({}) } as Response)
        .mockResolvedValueOnce({ status: 404, json: async () => ({}) } as Response);

      write('package-lock.json', JSON.stringify({
        packages: {
          'node_modules/express': { version: '1.0.0' },
          'node_modules/fake-slop-pkg': { version: '999.0.0' },
        },
      }));
      const checks = await verifyLockfileVersions(path.join(tmpDir, 'package-lock.json'));
      expect(checks.find((c) => c.packageName === 'express')?.severity).toBe('PASS');
      const fake = checks.find((c) => c.packageName === 'fake-slop-pkg');
      expect(fake?.severity).toBe('HALLUCINATION');
    });

    it('downgrades 404 to SUSPICIOUS when a private registry is configured', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 404,
        json: async () => ({}),
      } as Response);
      write('.npmrc', '@acme:registry=https://npm.acme.io\n');
      write('package-lock.json', JSON.stringify({
        packages: { 'node_modules/@acme/design-system': { version: '1.2.3' } },
      }));
      const checks = await verifyLockfileVersions(path.join(tmpDir, 'package-lock.json'), tmpDir);
      expect(checks[0].severity).toBe('SUSPICIOUS');
      expect(checks[0].reasons[0]).toContain('possible internal package');
    });

    it('fails open (PASS) when the registry request errors', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      write('package-lock.json', JSON.stringify({
        packages: { 'node_modules/express': { version: '4.19.2' } },
      }));
      const checks = await verifyLockfileVersions(path.join(tmpDir, 'package-lock.json'));
      expect(checks[0].severity).toBe('PASS');
      warn.mockRestore();
    });

    it('returns empty array for empty lockfiles', async () => {
      write('package-lock.json', JSON.stringify({ packages: {} }));
      const checks = await verifyLockfileVersions(path.join(tmpDir, 'package-lock.json'));
      expect(checks).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/drift.test.ts`
Expected: FAIL — module `../drift` not found.

- [ ] **Step 3: Implement `src/drift.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';
import { valid, validRange, satisfies } from 'semver';
import { parse as parseToml } from 'smol-toml';
import { parseLockfile, lockfileRegistryType, LockfilePackage } from './lockfiles';
import { checkPackageVersion, PackageCheckResult } from './registry';
import { hasPrivateRegistry } from './registry-config';

export interface DriftPackage {
  name: string;
  manifestRange?: string;
  lockfileVersion?: string;
  severity: 'PASS' | 'SUSPICIOUS';
  reasons: string[];
}

export interface DriftReport {
  packages: DriftPackage[];
  suspiciousCount: number;
  hallucinationCount: number;
  durationMs: number;
}

const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock'];

export function checkDrift(dir: string): DriftReport {
  const startTime = performance.now();
  const report: DriftReport = {
    packages: [],
    suspiciousCount: 0,
    hallucinationCount: 0,
    durationMs: 0,
  };

  const manifestRanges = loadManifestPackageRange(dir);
  const lockPackages = loadAllLockfilePackages(dir);

  if (Object.keys(manifestRanges).length === 0 && lockPackages.length === 0) {
    report.durationMs = Math.round(performance.now() - startTime);
    return report;
  }

  const lockedByName = new Map<string, string[]>();
  for (const locked of lockPackages) {
    const list = lockedByName.get(locked.name) ?? [];
    list.push(locked.version);
    lockedByName.set(locked.name, list);
  }

  const names = new Set([...Object.keys(manifestRanges), ...lockedByName.keys()]);
  for (const name of names) {
    const range = manifestRanges[name];
    const lockedVersions = lockedByName.get(name) ?? [];

    if (range && lockedVersions.length === 0) {
      report.packages.push({
        name,
        manifestRange: range,
        severity: 'SUSPICIOUS',
        reasons: ['Declared in manifest but absent from lockfile'],
      });
      report.suspiciousCount++;
      continue;
    }

    const lockedVersion = lockedVersions[0];
    let severity: 'PASS' | 'SUSPICIOUS' = 'PASS';
    const reasons: string[] = [];

    if (range && validRange(range) && lockedVersion && valid(lockedVersion)) {
      const satisfied = lockedVersions.some((v) => satisfies(v, range));
      if (!satisfied) {
        severity = 'SUSPICIOUS';
        reasons.push(`Version drift: manifest ${range} vs lockfile ${lockedVersion}`);
      }
    } else if (!range) {
      reasons.push('Lockfile-only entry (not declared in manifest)');
    }

    report.packages.push({
      name,
      manifestRange: range,
      lockfileVersion: lockedVersion,
      severity,
      reasons,
    });
    if (severity === 'SUSPICIOUS') {
      report.suspiciousCount++;
    }
  }

  report.durationMs = Math.round(performance.now() - startTime);
  return report;
}

function loadManifestPackageRange(dir: string): Record<string, string> {
  const ranges: Record<string, string> = {};

  const packageJsonPath = path.join(dir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = pkg[section];
        if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
          for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
            if (typeof range === 'string') {
              ranges[name] = range;
            }
          }
        }
      }
    } catch {
      /* ignore malformed package.json */
    }
  }

  const pyprojectPath = path.join(dir, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const doc = parseToml(fs.readFileSync(pyprojectPath, 'utf-8')) as Record<string, unknown>;
      const poetry = ((doc.tool ?? {}) as Record<string, unknown>).poetry as
        | Record<string, unknown>
        | undefined;
      const dependencies = poetry?.dependencies;
      if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
        for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
          if (name === 'python') continue;
          if (typeof spec === 'string') {
            ranges[name] = spec;
          } else if (
            spec &&
            typeof spec === 'object' &&
            typeof (spec as { version?: unknown }).version === 'string'
          ) {
            ranges[name] = (spec as { version: string }).version;
          }
        }
      }
    } catch {
      /* ignore malformed pyproject.toml */
    }
  }

  return ranges;
}

function loadAllLockfilePackages(dir: string): LockfilePackage[] {
  const all: LockfilePackage[] = [];
  for (const name of LOCKFILE_NAMES) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath)) {
      all.push(...parseLockfile(filePath));
    }
  }
  return all;
}

export interface LockfileVersionViolation {
  packageName: string;
  version: string;
  exists: boolean;
  severity: 'PASS' | 'SUSPICIOUS' | 'HALLUCINATION';
  reasons: string[];
}

export async function verifyLockfileVersions(
  filePath: string,
  dir?: string,
): Promise<LockfileVersionViolation[]> {
  const packages = parseLockfile(filePath);
  if (packages.length === 0) {
    return [];
  }
  const registry = lockfileRegistryType(filePath);
  const baseDir = dir ?? path.dirname(filePath);
  const privateRegistry = hasPrivateRegistry(baseDir);

  const results: LockfileVersionViolation[] = [];
  const concurrency = 10;
  for (let i = 0; i < packages.length; i += concurrency) {
    const batch = packages.slice(i, i + concurrency);
    const checked = await Promise.all(
      batch.map(async (pkg): Promise<LockfileVersionViolation> => {
        const result: PackageCheckResult = await checkPackageVersion(
          pkg.name,
          pkg.version,
          registry,
        );
        if (result.error) {
          return {
            packageName: pkg.name,
            version: pkg.version,
            exists: false,
            severity: 'PASS',
            reasons: ['registry check failed, failing open'],
          };
        }
        if (result.exists) {
          return {
            packageName: pkg.name,
            version: pkg.version,
            exists: true,
            severity: 'PASS',
            reasons: [],
          };
        }
        return {
          packageName: pkg.name,
          version: pkg.version,
          exists: false,
          severity: privateRegistry ? 'SUSPICIOUS' : 'HALLUCINATION',
          reasons: privateRegistry
            ? ['possible internal package — consider scoping']
            : [`Version ${pkg.version} not found on ${registry} registry`],
        };
      }),
    );
    results.push(...checked);
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/drift.test.ts`
Expected: PASS — all drift + version-verification tests green (mocked fetch per test).

- [ ] **Step 5: Commit**

```bash
git add src/drift.ts src/__tests__/drift.test.ts
git commit -m "feat: manifest/lockfile drift detection and lockfile version verification"
```

---

### Task 5: `config.ts` passthrough + new `slop-stop check-drift` CLI command

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/__tests__/cli.test.ts`

**Interfaces (consumes):**
- Task 1: `LOCKFILE_BASENAMES`
- Task 3: `isInternal` (registry-config), re-exported via config.ts
- Task 4: `checkDrift`, `verifyLockfileVersions`, `DriftReport`, `LockfileVersionViolation`

**Interfaces (produces):**
- `src/config.ts` exports `isInternal(packageName: string, dir?: string): boolean` (passthrough)
- `src/index.ts` exports `program` (so tests can inspect registered commands)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/cli.test.ts` (inside the existing `describe`, after the `it(...)`):

```ts
  it('registers the check-drift command', async () => {
    const { program } = await import('../index');
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('check-drift');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/cli.test.ts`
Expected: FAIL — `check-drift` not in the command list.

- [ ] **Step 3: Implement `config.ts` passthrough and the `check-drift` command**

**`src/config.ts`** — add at the bottom:

```ts
import { isInternal as isInternalRegistryPackage } from './registry-config';

export function isInternal(packageName: string, dir?: string): boolean {
  return isInternalRegistryPackage(packageName, dir);
}
```

**`src/index.ts`:**

Change `const program = new Command();` (line 15) to:

```ts
export const program = new Command();
```

Update the import line for config to:

```ts
import { isAllowed, isInternal } from './config';
```

Add these imports alongside the existing ones at the top of the file:

```ts
import { LOCKFILE_BASENAMES } from './lockfiles';
import { checkDrift, verifyLockfileVersions, LockfileVersionViolation } from './drift';
import { hasPrivateRegistry } from './registry-config';
```

Add the command right after the `check` command definition (before the `watch` command), and ensure `verifyLockfileVersions` + `LockfileVersionViolation` are used:

```ts
program
  .command('check-drift')
  .description('Check manifest vs lockfile drift and verify resolved lockfile versions')
  .argument('[directory]', 'target directory', '.')
  .action(async (directory: string) => {
    const startTime = performance.now();
    const targetDir = path.resolve(directory);
    if (!fs.existsSync(targetDir)) {
      console.log(chalk.red(`Directory not found: ${targetDir}`));
      process.exit(1);
    }

    const report = checkDrift(targetDir);
    const lockfiles = LOCKFILE_BASENAMES
      .map((name) => path.join(targetDir, name))
      .filter((file) => fs.existsSync(file));

    if (report.packages.length === 0 && lockfiles.length === 0) {
      console.log(chalk.green('No manifest or lockfile found in directory.') + chalk.dim(` [${Math.round(performance.now() - startTime)}ms]`));
      return;
    }

    const checks: LockfileVersionViolation[] = [];
    for (const lockfile of lockfiles) {
      checks.push(...await verifyLockfileVersions(lockfile, targetDir));
    }

    let suspiciousCount = report.suspiciousCount;
    let hallucinationCount = 0;

    console.log(chalk.blue(`Checking drift in ${targetDir}...`));

    for (const pkg of report.packages) {
      const statusColor = pkg.severity === 'SUSPICIOUS'
        ? chalk.yellow(`[${pkg.severity}]`)
        : chalk.green(`[${pkg.severity}]`);
      console.log(`  ${chalk.bold(pkg.name)} ${chalk.dim(pkg.manifestRange ?? '-')} → ${chalk.dim(pkg.lockfileVersion ?? '-')} ${statusColor}`);
      for (const reason of pkg.reasons) {
        console.log(`    ${chalk.dim('→')} ${reason}`);
      }
    }

    for (const check of checks) {
      switch (check.severity) {
        case 'PASS':
          console.log(`  ${chalk.green('[PASS]')} ${check.packageName}@${check.version}`);
          break;
        case 'SUSPICIOUS':
          console.log(`  ${chalk.yellow('[SUSPICIOUS]')} ${check.packageName}@${check.version}`);
          for (const reason of check.reasons) {
            console.log(`    ${chalk.yellow('→')} ${reason}`);
          }
          suspiciousCount++;
          break;
        case 'HALLUCINATION':
          console.log(`  ${chalk.red('[HALLUCINATION]')} ${check.packageName}@${check.version}`);
          for (const reason of check.reasons) {
            console.log(`    ${chalk.red('→')} ${reason}`);
          }
          hallucinationCount++;
          break;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    console.log();
    if (hallucinationCount > 0) {
      console.log(chalk.red(`Found ${hallucinationCount} locked version(s) that do not exist on the registry.`) + chalk.dim(` [${durationMs}ms]`));
      process.exit(1);
    }
    if (suspiciousCount > 0) {
      console.log(chalk.yellow(`Found ${suspiciousCount} drift or version issue(s).`) + chalk.dim(` [${durationMs}ms]`));
      return;
    }
    console.log(chalk.green('No drift detected. All locked versions verified.') + chalk.dim(` [${durationMs}ms]`));
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/cli.test.ts` && `npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Manual smoke test**

```bash
npm run build
mkdir -p /tmp/slop-stop-drift-demo && cd /tmp/slop-stop-drift-demo && npm init -y >/dev/null 2>&1 && npm i express >/dev/null 2>&1
node /home/abhinav/Documents/github/slop-stop/dist/index.js check-drift /tmp/slop-stop-drift-demo
```

Expected: rows for `express` with a cleared PASS (range satisfied), version checks green, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/index.ts src/__tests__/cli.test.ts
git commit -m "feat: slop-stop check-drift command for manifest/lockfile drift and version existence"
```

---

### Task 6: `check` command — internal auto-PASS, lockfile verification, private-registry downgrade

**Files:**
- Modify: `src/index.ts` (inside the existing `check` command action)

**Interfaces (consumes):** Task 1 `isLockfile`; Task 3 `isInternal` + `hasPrivateRegistry` (via config passthrough); Task 4 `verifyLockfileVersions`.

**Behavior:**
- `check <file>` where the basename is a lockfile → verify each locked version (PASS/SUSPICIOUS/HALLUCINATION with reasons), printed like the existing per-package lines, then a summary line with `[ms]`. No `process.exit` on hard errors (`check` remains an informational command, exit 0).
- Internal check sits exactly in the same position as the existing `isAllowed` check (before the registry call): `isAllowed(name) || isInternal(name, dir)` → `[PASS] (allowlisted)` / `[PASS] (internal)`.
- If a package evaluation comes back `HALLUCINATION` (404) and `hasPrivateRegistry(dir)` is true, downgrade to `SUSPICIOUS` with reason `possible internal package — consider scoping` (do NOT hard-block; the hook still hard-blocks).

- [ ] **Step 1: Implement (this task has integration-tested behavior; unit coverage lives in Task 4/7 suites)**

Replace the extraction/evaluation section of the existing `check` action in `src/index.ts` (from `const packages = extractDeps(file);` through the end of the `for (const result of results)` loop) with:

```ts
    const dir = path.dirname(path.resolve(file));

    if (isLockfile(file)) {
      const checks = await verifyLockfileVersions(path.resolve(file), dir);
      if (checks.length === 0) {
        console.log(chalk.green('No packages found in lockfile.'));
        return;
      }
      let hallucinationCount = 0;
      let suspiciousCount = 0;
      for (const check of checks) {
        switch (check.severity) {
          case 'PASS':
            console.log(`  ${chalk.green('[PASS]')} ${check.packageName}@${check.version}`);
            break;
          case 'SUSPICIOUS':
            console.log(`  ${chalk.yellow('[SUSPICIOUS]')} ${check.packageName}@${check.version}`);
            for (const reason of check.reasons) {
              console.log(`    ${chalk.yellow('→')} ${reason}`);
            }
            suspiciousCount++;
            break;
          case 'HALLUCINATION':
            console.log(`  ${chalk.red('[HALLUCINATION]')} ${check.packageName}@${check.version}`);
            for (const reason of check.reasons) {
              console.log(`    ${chalk.red('→')} ${reason}`);
            }
            hallucinationCount++;
            break;
        }
      }
      const durationMs = Math.round(performance.now() - startTime);
      console.log();
      if (hallucinationCount > 0) {
        console.log(chalk.red(`Found ${hallucinationCount} locked version(s) that do not exist on the registry.`) + chalk.dim(` [${durationMs}ms]`));
        return;
      }
      if (suspiciousCount > 0) {
        console.log(chalk.yellow(`Found ${suspiciousCount} suspicious locked version(s).`) + chalk.dim(` [${durationMs}ms]`));
        return;
      }
      console.log(chalk.green('All locked versions verified on registry.') + chalk.dim(` [${durationMs}ms]`));
      return;
    }

    const packages = extractDeps(file);
    if (packages.length === 0) {
      console.log(chalk.green('No third-party packages found.'));
      return;
    }

    const isPy = file.endsWith('.py') || file.endsWith('requirements.txt');
    const registry = isPy ? 'pypi' : 'npm';
    const results = await checkPackages(packages, registry);

    let hallucinationCount = 0;
    let suspiciousCount = 0;

    for (const result of results) {
      if (isAllowed(result.packageName) || isInternal(result.packageName, dir)) {
        const reason = isAllowed(result.packageName) ? 'allowlisted' : 'internal';
        console.log(`  ${chalk.green('[PASS]')} ${result.packageName} ${chalk.dim(`(${reason})`)}`);
        continue;
      }

      let evaluation = isPy
        ? evaluatePyPiPackage(result.exists, result.data)
        : evaluateNpmPackage(result.exists, result.data);

      if (evaluation.severity === 'HALLUCINATION' && hasPrivateRegistry(dir)) {
        evaluation = {
          severity: 'SUSPICIOUS',
          reasons: ['possible internal package — consider scoping'],
        };
      }

      switch (evaluation.severity) {
        case 'PASS':
          console.log(`  ${chalk.green('[PASS]')} ${result.packageName}`);
          break;
        case 'SUSPICIOUS':
          console.log(`  ${chalk.yellow('[SUSPICIOUS]')} ${result.packageName}`);
          for (const reason of evaluation.reasons) {
            console.log(`    ${chalk.yellow('→')} ${reason}`);
          }
          suspiciousCount++;
          break;
        case 'HALLUCINATION':
          console.log(`  ${chalk.red('[HALLUCINATION]')} ${result.packageName}`);
          hallucinationCount++;
          break;
      }
    }
```

Add to the imports in `src/index.ts`:

```ts
import { isLockfile } from './lockfiles';
import { verifyLockfileVersions } from './drift';
import { hasPrivateRegistry } from './registry-config';
```

(and ensure `isInternal` is imported from `./config` as in Task 5).

- [ ] **Step 2: Typecheck and run the full suite**

Run: `npx tsc --noEmit` then `npm test`
Expected: no type errors; all tests green.

- [ ] **Step 3: Manual smoke tests**

```bash
npm run build
node /home/abhinav/Documents/github/slop-stop/dist/index.js check /tmp/slop-stop-drift-demo/package-lock.json
node /home/abhinav/Documents/github/slop-stop/dist/index.js check /tmp/slop-stop-drift-demo/node_modules/express/index.js
```

Expected: lockfile path prints per-version lines + summary; a normal npm package path still verifies `express` as `[PASS]`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: internal-scope auto-pass, lockfile exact-version checks, 404 downgrade in check command"
```

---

### Task 7: Hook integration — staged lockfiles, drift, fake-version hard block

**Files:**
- Modify: `src/hook.ts`
- Modify: `src/__tests__/hook.test.ts`

**Interfaces (consumes):** Task 1 `isLockfile`; Task 3 `isInternal` (via config passthrough); Task 4 `checkDrift`, `verifyLockfileVersions`, `LockfileVersionViolation`.

**Changes:**
- `getStagedFiles`: filter also includes the 4 lockfile basenames.
- `checkStagedFiles` per staged file: if `isLockfile(relativeFile)` → `verifyLockfileVersions(fullPath, targetDir)`; each check is pushed as a detail with the check's severity; version checks bump `hallucinationCount` / `suspiciousCount`.
- Normal-file evaluation loop: `isAllowed(...) || isInternal(name, targetDir)` → PASS detail.
- After the per-file loop, if any staged file is a lockfile → run `checkDrift(targetDir)` and fold every `SUSPICIOUS` drift package into `suspiciousCount` + a detail row with `file: <lockfile basename>`.
- Exit code: unchanged rule — `1` if `hallucinationCount > 0`, else `0` (drift/version-SUSPICIOUS stays 0).

- [ ] **Step 1: Write the failing tests**

Add imports at the top of `src/__tests__/hook.test.ts`:

```ts
import { vi } from 'vitest';
import { getStagedFiles } from '../hook';
```

Add to the `describe('checkStagedFiles', ...)` block (after the existing tests):

```ts
    it('getStagedFiles includes lockfile basenames', () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({ packages: {} }));
      fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'x');
      execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
      const files = getStagedFiles(tmpDir);
      expect(files).toEqual(['package-lock.json']);
    });

    it('blocks commit (exit 1) when a staged lockfile contains a non-existent version', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404, json: async () => ({}) } as Response);

      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({
        packages: { 'node_modules/fake-ver-xyz-9999': { version: '404.0.0' } },
      }));

      execSync('git add package-lock.json', { cwd: tmpDir, stdio: 'ignore' });

      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(1);
      expect(result.hallucinationCount).toBe(1);
    });

    it('soft-warns (exit 0) on drift when a staged lockfile breaks the manifest range', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, json: async () => ({}) } as Response);

      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { express: '^2.0.0' } }));
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({
        packages: { 'node_modules/express': { version: '1.0.3' } },
      }));

      execSync('git add package.json package-lock.json', { cwd: tmpDir, stdio: 'ignore' });

      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.suspiciousCount).toBeGreaterThan(0);
    });

    it('auto-passes internal scoped packages without registry calls', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fs.writeFileSync(path.join(tmpDir, '.npmrc'), '@acme:registry=https://npm.acme.io\n');
      const testFile = path.join(tmpDir, 'internal.ts');
      fs.writeFileSync(testFile, "import x from '@acme/design-system';");
      execSync('git add -A .npmrc internal.ts', { cwd: tmpDir, stdio: 'ignore' });

      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.hallucinationCount).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/hook.test.ts`
Expected: FAIL — `getStagedFiles` exported but filter misses lockfiles; staged lockfile path not handled.

- [ ] **Step 3: Implement the `hook.ts` changes**

**Imports** (add to existing import block):

```ts
import { isLockfile } from './lockfiles';
import { checkDrift, verifyLockfileVersions } from './drift';
import { isInternal } from './config';
```

**`getStagedFiles` filter** (replace the `supportedExts`/return block):

```ts
    const supportedExts = ['.js', '.jsx', '.ts', '.tsx', '.py'];
    const supportedBasenames = ['package.json', 'requirements.txt', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock'];

    return lines.filter((file) => {
      const ext = path.extname(file);
      const base = path.basename(file);
      return supportedExts.includes(ext) || supportedBasenames.includes(base);
    });
```

**Per-file loop in `checkStagedFiles`** — right after `if (!fs.existsSync(fullPath)) continue;` insert:

```ts
    if (isLockfile(relativeFile)) {
      const checks = await verifyLockfileVersions(fullPath, targetDir);
      for (const check of checks) {
        summary.details.push({
          file: relativeFile,
          packageName: check.packageName,
          evaluation: { severity: check.severity, reasons: check.reasons },
          allowlisted: false,
        });
        summary.totalPackages++;
        if (check.severity === 'HALLUCINATION') {
          summary.hallucinationCount++;
        } else if (check.severity === 'SUSPICIOUS') {
          summary.suspiciousCount++;
        }
      }
      continue;
    }
```

**Evaluation loop inner check** (replace the `if (isAllowed(...))` block):

```ts
      if (isAllowed(result.packageName) || isInternal(result.packageName, targetDir)) {
        const reason = isAllowed(result.packageName) ? 'allowlisted' : 'internal';
        summary.details.push({
          file: relativeFile,
          packageName: result.packageName,
          evaluation: { severity: 'PASS', reasons: [reason] },
          allowlisted: isAllowed(result.packageName),
        });
        continue;
      }
```

**After the per-file loop** (before the `if (summary.hallucinationCount > 0)` exit-code block):

```ts
    const stagedLockfile = stagedFiles.find(isLockfile);
    if (stagedLockfile) {
      const driftReport = checkDrift(targetDir);
      for (const pkg of driftReport.packages) {
        if (pkg.severity === 'SUSPICIOUS') {
          summary.details.push({
            file: stagedLockfile,
            packageName: pkg.name,
            evaluation: { severity: 'SUSPICIOUS', reasons: pkg.reasons },
            allowlisted: false,
          });
          summary.suspiciousCount++;
        }
      }
    }
```

Note: `evaluation: { severity: check.severity, ... }` where `check.severity` is `'PASS' | 'SUSPICIOUS' | 'HALLUCINATION'`, which is a superset of `EvaluationResult['severity']` — the `details` type from `src/hook.ts` (`EvaluationResult`) declares `'PASS' | 'SUSPICIOUS' | 'HALLUCINATION'`, so widening is fine; if tsc complains about the literal union, cast `check.severity as EvaluationResult['severity']`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/hook.test.ts` then `npm test`
Expected: PASS — all new staged-lockfile + internal-scope tests green; existing hook tests intact; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/hook.ts src/__tests__/hook.test.ts
git commit -m "feat: staged-file lockfile version checks and drift warnings in pre-commit hook"
```

---

### Task 8: Watcher integration (`src/watcher.ts`)

**Files:**
- Modify: `src/watcher.ts`
- Modify: `src/__tests__/watcher.test.ts`

**Interfaces (consumes):** Task 1 `isLockfile`, `lockfileRegistryType`; Task 3 `isInternal` (config passthrough); Task 4 `verifyLockfileVersions`.

**Changes:**
- `watchPatterns` gains `'**/package-lock.json'`, `'**/pnpm-lock.yaml'`, `'**/yarn.lock'`, `'**/poetry.lock'`.
- `scanFileForWatcher`: lockfile path → version verification (counts map to `summary.hallucinated`/`suspicious`/`passed`). Normal-file loop: `isAllowed(name) || isInternal(name, path.dirname(filePath))` → treated as PASS with reason `internal` (not counted as allowlisted).

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/watcher.test.ts` (check existing imports first — add `vi` if missing):

```ts
  it('scanFileForWatcher verifies lockfile versions (HALLUCINATION on missing version)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404, json: async () => ({}) } as Response);
    const lockfilePath = path.join(tmpDir, 'package-lock.json');
    fs.writeFileSync(lockfilePath, JSON.stringify({
      packages: { 'node_modules/fake-lock-ver-7777': { version: '7777.0.0' } },
    }));

    const summary = await scanFileForWatcher(lockfilePath, { quiet: true });
    expect(summary.hallucinated).toBe(1);
    expect(summary.details[0].evaluation.severity).toBe('HALLUCINATION');
  });

  it('scanFileForWatcher auto-passes internal scopes without registry calls', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    fs.writeFileSync(path.join(tmpDir, '.npmrc'), '@acme:registry=https://npm.acme.io\n');
    const testFile = path.join(tmpDir, 'internal.ts');
    fs.writeFileSync(testFile, "import x from '@acme/design-system';");

    const summary = await scanFileForWatcher(testFile, { quiet: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(summary.passed).toBe(1);
    expect(summary.allowlisted).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/watcher.test.ts`
Expected: FAIL — lockfile path currently extracts no packages / 404 not counted; internal scope goes to the registry.

- [ ] **Step 3: Implement `src/watcher.ts` changes**

**Imports:**

```ts
import { isLockfile, lockfileRegistryType } from './lockfiles';
import { verifyLockfileVersions } from './drift';
import { isInternal } from './config';
```

**`watchPatterns`** — add the four entries at the end.

**`scanFileForWatcher`** — insert right after `const startTime = performance.now();`:

```ts
  if (isLockfile(filePath)) {
    const summary: ScanSummary = {
      filePath,
      total: 0,
      passed: 0,
      suspicious: 0,
      hallucinated: 0,
      allowlisted: 0,
      durationMs: 0,
      details: [],
    };
    const checks = await verifyLockfileVersions(filePath, path.dirname(filePath));
    summary.total = checks.length;
    for (const check of checks) {
      summary.details.push({
        packageName: check.packageName,
        evaluation: { severity: check.severity, reasons: check.reasons },
        allowlisted: false,
      });
      switch (check.severity) {
        case 'PASS':
          summary.passed++;
          break;
        case 'SUSPICIOUS':
          summary.suspicious++;
          break;
        case 'HALLUCINATION':
          summary.hallucinated++;
          break;
      }
    }
    summary.durationMs = Math.round(performance.now() - startTime);
    if (!options.quiet) {
      logWatcherResult(summary);
    }
    if (options.onScanComplete) {
      options.onScanComplete(filePath, summary);
    }
    return summary;
  }
```

**Evaluation-loop allowed check** (replace `if (isAllowed(...))`):

```ts
    if (isAllowed(result.packageName) || isInternal(result.packageName, path.dirname(filePath))) {
      const isAllow = isAllowed(result.packageName);
      summary.allowlisted += isAllow ? 1 : 0;
      summary.passed += isAllow ? 0 : 1;
      summary.details.push({
        packageName: result.packageName,
        evaluation: { severity: 'PASS', reasons: [isAllow ? 'allowlisted' : 'internal'] },
        allowlisted: isAllow,
      });
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/watcher.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watcher.ts src/__tests__/watcher.test.ts
git commit -m "feat: watcher lockfile version checks and internal-scope auto-pass"
```

---

### Task 9: Full suite, typecheck, ROADMAP update

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Full test pass**

Run: `npm test`
Expected: all suites green; target ≥ 85 tests.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit` && `npm run build`
Expected: zero errors; `dist/` regenerates.

- [ ] **Step 3: Update ROADMAP.md**

Replace the two pending Day 17 / Day 18 bullets (currently without `✅`) with:

```markdown
- **Day 17: Lockfile Parsing & Lockfile Drift Inspector ✅**
  - Parse `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and `poetry.lock`.
  - Inspect exact resolved package versions (not just semver specifiers).
  - Flag manifest↔lockfile version drift as `SUSPICIOUS`.

- **Day 18: Private Registry & Scope Auto-Detection ✅**
  - Auto-read `.npmrc` (scope → registry mappings), `pip.conf`/`pip.ini`, and `pyproject.toml` (Poetry sources).
  - Automatically pass internal scopes (`@mycompany/*`, Verdaccio, Artifactory) without manual allowlist clutter.
  - Flag unscoped internal package names that risk leaking to the public npm registry.
  - 85+ unit tests passing across 10 test suites.
```

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark Days 17-18 complete in roadmap"
```

---

## Self-Review Notes

- **Spec coverage:** lockfile parsing (T1), registry version checks (T2), registry-config (T3), drift + version verification (T4), `check-drift` CLI + config passthrough (T5), `check` integration (T6), hook (T7), watcher (T8), roadmap (T9).
- **Type consistency:** `LockfilePackage`, `LockfileVersionViolation`, `DriftPackage`, `DriftReport` names/params consistent across files; `checkPackageVersion(name, version, registry)` is the single version-check entry point; `verifyLockfileVersions(filePath, dir?)` used everywhere a lockfile version check happens.
- **Spec deviation (approved in brainstorm):** `checkNpmVersion`/`checkPyPiVersion` merged into `checkPackageVersion`; downgrade reason copy `possible internal package — consider scoping` used in `verifyLockfileVersions` and `check`.
- **Test realism:** registry tests stub global `fetch` status codes; watcher/hook tests stub both sides; all drift tests are mocked, so no live network.
- **Known safe simplifications:** pnpm versions strip `_`/`(...)` suffixes; yarn multi-key expansion; `semver` guards (validRange/valid) prevent non-semver false positives.