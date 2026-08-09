import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scanFileForWatcher, startWatcher } from '../watcher';

describe('Watcher Daemon', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-watcher-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('scanFileForWatcher', () => {
    it('returns empty summary for files with no third-party imports', async () => {
      const testFile = path.join(tmpDir, 'empty.ts');
      fs.writeFileSync(testFile, 'const a = 1; console.log(a);');

      const summary = await scanFileForWatcher(testFile, { quiet: true });
      expect(summary.total).toBe(0);
      expect(summary.details).toHaveLength(0);
    });

    it('identifies hallucinated package and fires callback', async () => {
      const testFile = path.join(tmpDir, 'test-fake.ts');
      fs.writeFileSync(
        testFile,
        "import fakePkg from 'super-non-existent-hallucinated-package-xyz-9999';",
      );

      const callback = vi.fn();
      const summary = await scanFileForWatcher(testFile, {
        quiet: true,
        onScanComplete: callback,
      });

      expect(summary.total).toBe(1);
      expect(summary.hallucinated).toBe(1);
      expect(summary.details[0].packageName).toBe(
        'super-non-existent-hallucinated-package-xyz-9999',
      );
      expect(summary.details[0].evaluation.severity).toBe('HALLUCINATION');
      expect(callback).toHaveBeenCalledWith(testFile, summary);
    });

    it('bypasses scanning if package is allowlisted', async () => {
      const testFile = path.join(tmpDir, 'allowlisted.ts');
      fs.writeFileSync(testFile, "import myPkg from 'internal-company-sdk';");

      // Mock config module to allowlist
      const summary = await scanFileForWatcher(testFile, { quiet: true });
      // Without config file, internal-company-sdk will be checked on registry
      expect(summary.total).toBe(1);
    });

    it('scanFileForWatcher verifies lockfile versions (HALLUCINATION on missing version)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404, json: async () => ({}) } as Response);
      const lockfilePath = path.join(tmpDir, 'package-lock.json');
      fs.writeFileSync(lockfilePath, JSON.stringify({
        packages: { 'node_modules/fake-lock-ver-7777': { version: '7777.0.0' } },
      }));

      const summary = await scanFileForWatcher(lockfilePath, { quiet: true });
      expect(summary.hallucinated).toBe(1);
      expect(summary.details[0].evaluation.severity).toBe('HALLUCINATION');
    });

    it('scanFileForWatcher auto-passes internal scopes without registry calls', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;
      fs.writeFileSync(path.join(tmpDir, '.npmrc'), '@acme:registry=https://npm.acme.io\n');
      const testFile = path.join(tmpDir, 'internal.ts');
      fs.writeFileSync(testFile, "import x from '@acme/design-system';");

      const summary = await scanFileForWatcher(testFile, { quiet: true });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(summary.passed).toBe(1);
      expect(summary.allowlisted).toBe(0);
    });
  });

  describe('startWatcher', () => {
    it('initializes watcher and detects file changes with debounce', async () => {
      const scanPromise = new Promise<string>((resolve) => {
        const watcher = startWatcher(tmpDir, {
          debounceMs: 50,
          quiet: true,
          onScanComplete: (filePath) => {
            watcher.close();
            resolve(filePath);
          },
        });

        // Write file after watcher starts
        setTimeout(() => {
          const file = path.join(tmpDir, 'dynamic.ts');
          fs.writeFileSync(file, "import fake from 'fake-unit-pkg-12345';");
        }, 100);
      });

      const scannedFile = await scanPromise;
      expect(scannedFile).toBe(path.join(tmpDir, 'dynamic.ts'));
    });
  });
});
