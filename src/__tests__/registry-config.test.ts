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

    it('bare scoped names without a slash are not treated as internal', () => {
      write('.npmrc', '@acm:registry=https://npm.acme.io\n');
      expect(isInternal('@acme', tmpDir)).toBe(false);
      expect(isInternal('@acm/pkg', tmpDir)).toBe(true);
    });

    it('false when nothing is configured', () => {
      expect(isInternal('anything', tmpDir)).toBe(false);
    });
  });
});