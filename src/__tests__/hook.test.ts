import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installGitHook, checkStagedFiles, getStagedFiles } from '../hook';

describe('Git Hook & Staged Checker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-hook-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('installGitHook', () => {
    it('throws error if directory is not a git repository', () => {
      expect(() => installGitHook(tmpDir)).toThrow('Not a git repository');
    });

    it('installs native pre-commit hook in .git/hooks/pre-commit', () => {
      fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

      const result = installGitHook(tmpDir);
      expect(result.success).toBe(true);
      expect(result.type).toBe('native');

      const hookContent = fs.readFileSync(result.hookPath, 'utf-8');
      expect(hookContent).toContain('npx slop-stop check-staged');
    });

    it('installs into Husky pre-commit if .husky directory exists', () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });

      const result = installGitHook(tmpDir);
      expect(result.success).toBe(true);
      expect(result.type).toBe('husky');

      const hookContent = fs.readFileSync(result.hookPath, 'utf-8');
      expect(hookContent).toContain('npx slop-stop check-staged');
    });

    it('is idempotent and does not duplicate command on multiple installs', () => {
      fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

      installGitHook(tmpDir);
      installGitHook(tmpDir);

      const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
      const content = fs.readFileSync(hookPath, 'utf-8');
      const occurrences = (content.match(/slop-stop check-staged/g) || []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('checkStagedFiles', () => {
    it('returns exitCode 0 when no staged files are present', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.totalFiles).toBe(0);
    });

    it('returns exitCode 1 (Hard Block) when staged code contains a hallucinated package', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

      const testFile = path.join(tmpDir, 'staged-hallucination.ts');
      fs.writeFileSync(
        testFile,
        "import fake from 'super-fake-hallucinated-package-xyz-8888';",
      );

      execSync('git add staged-hallucination.ts', { cwd: tmpDir, stdio: 'ignore' });

      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(1); // Hard block
      expect(result.hallucinationCount).toBe(1);
    });

    it('getStagedFiles includes lockfile basenames', () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({ packages: {} }));
      fs.writeFileSync(path.join(tmpDir, 'unrelated.txt'), 'x');
      execSync('git add -A', { cwd: tmpDir, stdio: 'ignore' });
      const files = getStagedFiles(tmpDir);
      expect(files).toEqual(['package-lock.json']);
    });

    it('blocks commit (exit 1) when a staged lockfile contains a non-existent version', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 404, json: async () => ({}) } as Response);

      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({
        packages: { 'node_modules/fake-ver-xyz-9999': { version: '404.0.0' } },
      }));

      execSync('git add package-lock.json', { cwd: tmpDir, stdio: 'ignore' });

      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(1);
      expect(result.hallucinationCount).toBe(1);
    });

    it('soft-warns (exit 0) on drift when a staged lockfile breaks the manifest range', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, json: async () => ({}) } as Response);

      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { express: '^2.0.0' } }));
      fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({
        packages: { 'node_modules/express': { version: '1.0.3' } },
      }));

      execSync('git add package.json package-lock.json', { cwd: tmpDir, stdio: 'ignore' });

      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.suspiciousCount).toBeGreaterThan(0);
    });

    it('auto-passes internal scoped packages without registry calls', async () => {
      execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fs.writeFileSync(path.join(tmpDir, '.npmrc'), '@acme:registry=https://npm.acme.io\n');
      const testFile = path.join(tmpDir, 'internal.ts');
      fs.writeFileSync(testFile, "import x from '@acme/design-system';");
      execSync('git add -A .npmrc internal.ts', { cwd: tmpDir, stdio: 'ignore' });

      const result = await checkStagedFiles(tmpDir, { quiet: true });
      expect(result.exitCode).toBe(0);
      expect(result.hallucinationCount).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
