const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI_REGISTRY = 'https://pypi.org/pypi';

export interface PackageCheckResult {
  packageName: string;
  exists: boolean;
  data?: any;
  error?: string;
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
  try {
    const url = registryUrl(packageName, registry);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (response.status === 404) {
      return { packageName, exists: false };
    }

    if (response.status === 200) {
      const data = await response.json();
      return { packageName, exists: true, data };
    }

    return {
      packageName,
      exists: false,
      error: `Unexpected status: ${response.status}`,
    };
  } catch (e) {
    return {
      packageName,
      exists: false,
      error: (e as Error).message,
    };
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
