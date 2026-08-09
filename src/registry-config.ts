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
    const slash = packageName.indexOf('/');
    if (slash === -1) return false;
    const scope = packageName.slice(0, slash);
    return config.npmScopeRegistry.has(scope);
  }
  const hasPrivatePy =
    config.pipIndexUrls.some(isPrivateUrl) ||
    config.pyprojectSources.some((source) => isPrivateUrl(source.url));
  return hasPrivatePy && config.poetryDependencies.includes(packageName);
}