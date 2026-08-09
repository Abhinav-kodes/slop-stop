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

  it('parse yarn.lock v1 including multi-key entries', () => {
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