const NPM_REGISTRY = 'https://registry.npmjs.org';

export interface PackageCheckResult {
  packageName: string;
  exists: boolean;
  data?: any;
  error?: string;
}

export async function checkNpmPackage(packageName: string): Promise<PackageCheckResult> {
  try {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`;
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
