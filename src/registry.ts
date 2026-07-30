import { LRUCache } from 'lru-cache';

const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI_REGISTRY = 'https://pypi.org/pypi';

export interface PackageCheckResult {
  packageName: string;
  exists: boolean;
  data?: any;
  error?: string;
}

type RegistryStatus = 'REGISTRY_DOWN';

const cache = new LRUCache<string, PackageCheckResult | RegistryStatus>({
  max: 500,
  ttl: 1000 * 60 * 60 * 24,
});

function cacheKey(packageName: string, registry: string): string {
  return `${registry}:${packageName}`;
}

function setCache(
  key: string,
  result: PackageCheckResult | RegistryStatus,
): void {
  if (result === 'REGISTRY_DOWN') {
    cache.set(key, result, { ttl: 1000 * 60 * 5 });
    return;
  }
  if (!result.exists) {
    cache.set(key, result, { ttl: 1000 * 60 * 60 * 24 * 7 });
    return;
  }
  cache.set(key, result, { ttl: 1000 * 60 * 60 * 24 });
}

function registryUrl(packageName: string, registry: string): string {
  const encoded = encodeURIComponent(packageName);
  if (registry === PYPI_REGISTRY) {
    return `${registry}/${encoded}/json`;
  }
  return `${registry}/${encoded}`;
}

async function checkRegistry(
  packageName: string,
  registry: string,
): Promise<PackageCheckResult> {
  const key = cacheKey(packageName, registry);
  const cached = cache.get(key);
  if (cached && cached !== 'REGISTRY_DOWN') {
    return cached;
  }

  try {
    const url = registryUrl(packageName, registry);
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

    setCache(key, result);
    return result;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.warn(`Registry timeout for ${packageName}, failing open`);
    } else {
      console.warn(`Registry error for ${packageName}: ${err.message}`);
    }
    return { packageName, exists: false, error: err.message };
  }
}

export function checkNpmPackage(
  packageName: string,
): Promise<PackageCheckResult> {
  return checkRegistry(packageName, NPM_REGISTRY);
}

export function checkPyPiPackage(
  packageName: string,
): Promise<PackageCheckResult> {
  return checkRegistry(packageName, PYPI_REGISTRY);
}

export async function checkPackages(
  packages: string[],
  registryType: 'npm' | 'pypi',
  concurrency: number = 10,
): Promise<PackageCheckResult[]> {
  const checker =
    registryType === 'npm' ? checkNpmPackage : checkPyPiPackage;
  const results: PackageCheckResult[] = [];

  for (let i = 0; i < packages.length; i += concurrency) {
    const batch = packages.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(checker));
    results.push(...batchResults);
  }

  return results;
}
