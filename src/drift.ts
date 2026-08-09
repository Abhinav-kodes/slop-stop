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