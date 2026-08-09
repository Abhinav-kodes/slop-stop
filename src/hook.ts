import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { extractDeps } from './scanner';
import { checkPackages, PackageCheckResult } from './registry';
import { evaluateNpmPackage, evaluatePyPiPackage, EvaluationResult } from './heuristics';
import { isAllowed, isInternal } from './config';
import { isLockfile } from './lockfiles';
import { checkDrift, verifyLockfileVersions } from './drift';

export interface InstallHookResult {
  success: boolean;
  hookPath: string;
  type: 'husky' | 'native';
  message: string;
}

export interface CheckStagedResult {
  exitCode: number;
  totalFiles: number;
  totalPackages: number;
  hallucinationCount: number;
  suspiciousCount: number;
  durationMs: number;
  details: Array<{
    file: string;
    packageName: string;
    evaluation: EvaluationResult;
    allowlisted: boolean;
  }>;
}

const HOOK_COMMAND = 'npx slop-stop check-staged';

export function installGitHook(targetDir: string = process.cwd()): InstallHookResult {
  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Not a git repository: ${targetDir}`);
  }

  const huskyDir = path.join(targetDir, '.husky');
  const huskyPreCommit = path.join(huskyDir, 'pre-commit');

  if (fs.existsSync(huskyDir)) {
    if (!fs.existsSync(huskyPreCommit)) {
      fs.writeFileSync(huskyPreCommit, `#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\n\n${HOOK_COMMAND}\n`);
    } else {
      const content = fs.readFileSync(huskyPreCommit, 'utf-8');
      if (!content.includes('slop-stop check-staged')) {
        fs.appendFileSync(huskyPreCommit, `\n${HOOK_COMMAND}\n`);
      }
    }
    try {
      fs.chmodSync(huskyPreCommit, 0o755);
    } catch {}
    return {
      success: true,
      hookPath: huskyPreCommit,
      type: 'husky',
      message: `Hook successfully installed into Husky pre-commit at ${huskyPreCommit}`,
    };
  }

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const nativePreCommit = path.join(hooksDir, 'pre-commit');
  if (fs.existsSync(nativePreCommit)) {
    const content = fs.readFileSync(nativePreCommit, 'utf-8');
    if (!content.includes('slop-stop check-staged')) {
      const formatted = content.endsWith('\n') ? content : content + '\n';
      fs.writeFileSync(nativePreCommit, `${formatted}\n# Slop-Stop Pre-Commit Interceptor\n${HOOK_COMMAND}\n`);
    }
  } else {
    const script = `#!/bin/sh\n# Slop-Stop Pre-Commit Interceptor\n${HOOK_COMMAND}\n`;
    fs.writeFileSync(nativePreCommit, script);
  }

  try {
    fs.chmodSync(nativePreCommit, 0o755);
  } catch {}

  return {
    success: true,
    hookPath: nativePreCommit,
    type: 'native',
    message: `Native git pre-commit hook installed at ${nativePreCommit}`,
  };
}

export function getStagedFiles(targetDir: string = process.cwd()): string[] {
  try {
    const stdout = execSync('git diff --cached --name-only --diff-filter=ACM', {
      cwd: targetDir,
      encoding: 'utf-8',
    });

    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const supportedExts = ['.js', '.jsx', '.ts', '.tsx', '.py'];
    const supportedBasenames = ['package.json', 'requirements.txt', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock'];

    return lines.filter((file) => {
      const ext = path.extname(file);
      const base = path.basename(file);
      return supportedExts.includes(ext) || supportedBasenames.includes(base);
    });
  } catch {
    return [];
  }
}

export async function checkStagedFiles(
  targetDir: string = process.cwd(),
  options: { quiet?: boolean } = {},
): Promise<CheckStagedResult> {
  const startTime = performance.now();
  const stagedFiles = getStagedFiles(targetDir);

  const summary: CheckStagedResult = {
    exitCode: 0,
    totalFiles: stagedFiles.length,
    totalPackages: 0,
    hallucinationCount: 0,
    suspiciousCount: 0,
    durationMs: 0,
    details: [],
  };

  if (stagedFiles.length === 0) {
    summary.durationMs = Math.round(performance.now() - startTime);
    if (!options.quiet) {
      console.log(chalk.green('✓ No staged code or manifest files to check.'));
    }
    return summary;
  }

  if (!options.quiet) {
    console.log(chalk.blue(`Checking ${stagedFiles.length} staged file(s) for hallucinated packages...`));
  }

  for (const relativeFile of stagedFiles) {
    const fullPath = path.resolve(targetDir, relativeFile);
    if (!fs.existsSync(fullPath)) continue;

    if (isLockfile(relativeFile)) {
      const checks = await verifyLockfileVersions(fullPath, targetDir);
      for (const check of checks) {
        summary.details.push({
          file: relativeFile,
          packageName: check.packageName,
          evaluation: { severity: check.severity, reasons: check.reasons },
          allowlisted: false,
        });
        summary.totalPackages++;
        if (check.severity === 'HALLUCINATION') {
          summary.hallucinationCount++;
        } else if (check.severity === 'SUSPICIOUS') {
          summary.suspiciousCount++;
        }
      }
      continue;
    }

    const packages = extractDeps(fullPath);
    if (packages.length === 0) continue;

    const internalPackages = packages.filter((name) => isInternal(name, targetDir));
    for (const name of internalPackages) {
      summary.details.push({
        file: relativeFile,
        packageName: name,
        evaluation: { severity: 'PASS', reasons: ['internal'] },
        allowlisted: false,
      });
      summary.totalPackages++;
    }

    const externalPackages = packages.filter((name) => !internalPackages.includes(name));
    if (externalPackages.length === 0) continue;

    summary.totalPackages += externalPackages.length;
    const isPy = relativeFile.endsWith('.py') || relativeFile.endsWith('requirements.txt');
    const registry = isPy ? 'pypi' : 'npm';

    const results: PackageCheckResult[] = await checkPackages(externalPackages, registry);

    for (const result of results) {
      if (isAllowed(result.packageName) || isInternal(result.packageName, targetDir)) {
        const reason = isAllowed(result.packageName) ? 'allowlisted' : 'internal';
        summary.details.push({
          file: relativeFile,
          packageName: result.packageName,
          evaluation: { severity: 'PASS', reasons: [reason] },
          allowlisted: isAllowed(result.packageName),
        });
        continue;
      }

      const evaluation = isPy
        ? evaluatePyPiPackage(result.exists, result.data)
        : evaluateNpmPackage(result.exists, result.data);

      summary.details.push({
        file: relativeFile,
        packageName: result.packageName,
        evaluation,
        allowlisted: false,
      });

      if (evaluation.severity === 'HALLUCINATION') {
        summary.hallucinationCount++;
      } else if (evaluation.severity === 'SUSPICIOUS') {
        summary.suspiciousCount++;
      }
    }
  }

  const stagedLockfile = stagedFiles.find(isLockfile);
  if (stagedLockfile) {
    const driftReport = checkDrift(targetDir);
    for (const pkg of driftReport.packages) {
      if (pkg.severity === 'SUSPICIOUS') {
        summary.details.push({
          file: stagedLockfile,
          packageName: pkg.name,
          evaluation: { severity: pkg.severity, reasons: pkg.reasons },
          allowlisted: false,
        });
        summary.suspiciousCount++;
      }
    }
  }

  if (summary.hallucinationCount > 0) {
    summary.exitCode = 1; // Hard Block
  } else {
    summary.exitCode = 0; // Soft Warn or Pass
  }

  summary.durationMs = Math.round(performance.now() - startTime);

  if (!options.quiet) {
    logCheckStagedResult(summary);
  }

  return summary;
}

function logCheckStagedResult(summary: CheckStagedResult): void {
  if (summary.hallucinationCount > 0) {
    console.log('\n' + chalk.bgRed.white.bold(' 🚨 SLOP-STOP INTERCEPTED: COMMIT BLOCKED 🚨 ') + ` ${chalk.dim(`[${summary.durationMs}ms]`)}`);
    console.log(chalk.red.bold(`Found ${summary.hallucinationCount} confirmed hallucinated package(s) in staged files:`));
    for (const detail of summary.details) {
      if (detail.evaluation.severity === 'HALLUCINATION') {
        console.log(`  ${chalk.red('❌')} ${chalk.bold(detail.packageName)} ${chalk.dim(`(in ${detail.file})`)}`);
      }
    }
    console.log(chalk.red(`\nCommit has been HARD BLOCKED. Please remove non-existent packages before committing.`) + chalk.dim(` (completed in ${summary.durationMs}ms)\n`));
  } else if (summary.suspiciousCount > 0) {
    console.log('\n' + chalk.bgYellow.black.bold(' ⚠️ SLOP-STOP WARNING: SUSPICIOUS PACKAGES DETECTED ⚠️ ') + ` ${chalk.dim(`[${summary.durationMs}ms]`)}`);
    console.log(chalk.yellow(`Found ${summary.suspiciousCount} suspicious package(s) (high slopsquatting risk):`));
    for (const detail of summary.details) {
      if (detail.evaluation.severity === 'SUSPICIOUS') {
        console.log(`  ${chalk.yellow('⚠️')} ${chalk.bold(detail.packageName)} ${chalk.dim(`(in ${detail.file})`)}`);
        for (const reason of detail.evaluation.reasons) {
          console.log(`     ${chalk.yellow('→')} ${reason}`);
        }
      }
    }
    console.log(chalk.dim(`\nCommit allowed (Soft Warn). Please verify package authenticity. (completed in ${summary.durationMs}ms)\n`));
  } else {
    console.log(chalk.green(`\n✓ All ${summary.totalPackages} staged package(s) across ${summary.totalFiles} file(s) verified on registry.`) + chalk.dim(` [${summary.durationMs}ms]\n`));
  }
}

