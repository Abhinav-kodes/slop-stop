import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { extractDeps } from './scanner';
import { checkPackages, PackageCheckResult } from './registry';
import { evaluateNpmPackage, evaluatePyPiPackage, EvaluationResult } from './heuristics';
import { isAllowed } from './config';

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

    return lines.filter((file) => {
      const ext = path.extname(file);
      const base = path.basename(file);
      return supportedExts.includes(ext) || base === 'package.json' || base === 'requirements.txt';
    });
  } catch {
    return [];
  }
}

export async function checkStagedFiles(
  targetDir: string = process.cwd(),
  options: { quiet?: boolean } = {},
): Promise<CheckStagedResult> {
  const stagedFiles = getStagedFiles(targetDir);

  const summary: CheckStagedResult = {
    exitCode: 0,
    totalFiles: stagedFiles.length,
    totalPackages: 0,
    hallucinationCount: 0,
    suspiciousCount: 0,
    details: [],
  };

  if (stagedFiles.length === 0) {
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

    const packages = extractDeps(fullPath);
    if (packages.length === 0) continue;

    summary.totalPackages += packages.length;
    const isPy = relativeFile.endsWith('.py') || relativeFile.endsWith('requirements.txt');
    const registry = isPy ? 'pypi' : 'npm';

    const results: PackageCheckResult[] = await checkPackages(packages, registry);

    for (const result of results) {
      if (isAllowed(result.packageName)) {
        summary.details.push({
          file: relativeFile,
          packageName: result.packageName,
          evaluation: { severity: 'PASS', reasons: ['allowlisted'] },
          allowlisted: true,
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

  if (summary.hallucinationCount > 0) {
    summary.exitCode = 1; // Hard Block
  } else {
    summary.exitCode = 0; // Soft Warn or Pass
  }

  if (!options.quiet) {
    logCheckStagedResult(summary);
  }

  return summary;
}

function logCheckStagedResult(summary: CheckStagedResult): void {
  if (summary.hallucinationCount > 0) {
    console.log('\n' + chalk.bgRed.white.bold(' 🚨 SLOP-STOP INTERCEPTED: COMMIT BLOCKED 🚨 '));
    console.log(chalk.red.bold(`Found ${summary.hallucinationCount} confirmed hallucinated package(s) in staged files:`));
    for (const detail of summary.details) {
      if (detail.evaluation.severity === 'HALLUCINATION') {
        console.log(`  ${chalk.red('❌')} ${chalk.bold(detail.packageName)} ${chalk.dim(`(in ${detail.file})`)}`);
      }
    }
    console.log(chalk.red('\nCommit has been HARD BLOCKED. Please remove non-existent packages before committing.\n'));
  } else if (summary.suspiciousCount > 0) {
    console.log('\n' + chalk.bgYellow.black.bold(' ⚠️ SLOP-STOP WARNING: SUSPICIOUS PACKAGES DETECTED ⚠️ '));
    console.log(chalk.yellow(`Found ${summary.suspiciousCount} suspicious package(s) (high slopsquatting risk):`));
    for (const detail of summary.details) {
      if (detail.evaluation.severity === 'SUSPICIOUS') {
        console.log(`  ${chalk.yellow('⚠️')} ${chalk.bold(detail.packageName)} ${chalk.dim(`(in ${detail.file})`)}`);
        for (const reason of detail.evaluation.reasons) {
          console.log(`     ${chalk.yellow('→')} ${reason}`);
        }
      }
    }
    console.log(chalk.dim('\nCommit allowed (Soft Warn). Please verify package authenticity.\n'));
  } else {
    console.log(chalk.green(`\n✓ All ${summary.totalPackages} staged package(s) across ${summary.totalFiles} file(s) verified on registry.\n`));
  }
}
