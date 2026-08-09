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