import * as fs from 'fs';
import * as path from 'path';

export interface SlopStopConfig {
  allowlist?: string[];
  heuristics?: {
    maxAgeDays?: number;
  };
}

let cachedConfig: SlopStopConfig | null = null;

function loadConfigInner(rootDir?: string): SlopStopConfig {
  const dir = rootDir || process.cwd();
  const configPath = path.join(dir, '.slop-stop.json');

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function loadConfig(rootDir?: string): SlopStopConfig {
  if (cachedConfig === null) {
    cachedConfig = loadConfigInner(rootDir);
  }
  return cachedConfig;
}

export function isAllowed(packageName: string): boolean {
  const config = loadConfig();
  if (!config.allowlist || config.allowlist.length === 0) {
    return false;
  }
  return config.allowlist.includes(packageName);
}

export function getMaxAgeDays(): number {
  const config = loadConfig();
  return config.heuristics?.maxAgeDays ?? 14;
}

import { isInternal as isInternalRegistryPackage } from './registry-config';

export function isInternal(packageName: string, dir?: string): boolean {
  return isInternalRegistryPackage(packageName, dir);
}
