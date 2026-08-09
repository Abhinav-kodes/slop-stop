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
      const match = key.match(/^.*node_modules\/(@[^/]+\/[^/]+|[^/]+)$/);
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
  const urlMatch = key.match(/^(?:https?:\/\/)?[^/]+\/(@[^/]+\/[^/]+|[^/]+)\/([^/]+)$/);
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
  const source = contents.split('\n');
  const lines: string[] = [];
  let i = 0;
  while (i < source.length) {
    const multi = source[i].match(/^((?:"[^"]*")(?:\s*,\s*"[^"]*")+):$/);
    if (!multi) {
      lines.push(source[i]);
      i++;
      continue;
    }
    const keys = multi[1].match(/"[^"]*"/g);
    if (!keys) {
      lines.push(source[i]);
      i++;
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    while (j < source.length && (source[j].startsWith(' ') || source[j].startsWith('\t'))) {
      body.push(source[j]);
      j++;
    }
    for (const key of keys) {
      lines.push(`${key}:`);
      lines.push(...body);
    }
    i = j;
  }
  return lines
    .map((line) =>
      line.replace(/^(\s+)([^:#\s]+) "([^"]+)"\s*$/, '$1$2: "$3"'),
    )
    .join('\n');
}

function parseYarnLock(contents: string): LockfilePackage[] {
  const expanded = expandYarnMultiKeys(contents);
  const doc = parseYaml(expanded) as Record<string, { version?: unknown }> | null;
  if (!doc || typeof doc !== 'object') {
    return [];
  }
  const packages: LockfilePackage[] = [];
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata') continue;
    if (typeof entry !== 'object' || entry === null) continue;
    const version = (entry as { version?: unknown }).version;
    if (typeof version !== 'string' && typeof version !== 'number') continue;
    const name = yarnNameFromKey(key);
    if (seen.has(name)) continue;
    seen.add(name);
    packages.push({ name, version: String(version) });
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