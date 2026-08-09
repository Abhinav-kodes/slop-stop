import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import chalk from 'chalk';
import { extractDeps } from './scanner';
import { checkPackages, PackageCheckResult } from './registry';
import { evaluateNpmPackage, evaluatePyPiPackage, EvaluationResult } from './heuristics';
import { isAllowed, isInternal } from './config';
import { isLockfile } from './lockfiles';
import { verifyLockfileVersions } from './drift';

export interface WatcherOptions {
  debounceMs?: number;
  quiet?: boolean;
  onScanComplete?: (filePath: string, summary: ScanSummary) => void;
}

export interface ScanSummary {
  filePath: string;
  total: number;
  passed: number;
  suspicious: number;
  hallucinated: number;
  allowlisted: number;
  durationMs: number;
  details: Array<{
    packageName: string;
    evaluation: EvaluationResult;
    allowlisted: boolean;
  }>;
}

export async function scanFileForWatcher(
  filePath: string,
  options: WatcherOptions = {},
): Promise<ScanSummary> {
  const startTime = performance.now();

  if (isLockfile(filePath)) {
    const summary: ScanSummary = {
      filePath,
      total: 0,
      passed: 0,
      suspicious: 0,
      hallucinated: 0,
      allowlisted: 0,
      durationMs: 0,
      details: [],
    };
    const checks = await verifyLockfileVersions(filePath, path.dirname(filePath));
    summary.total = checks.length;
    for (const check of checks) {
      summary.details.push({
        packageName: check.packageName,
        evaluation: { severity: check.severity, reasons: check.reasons },
        allowlisted: false,
      });
      switch (check.severity) {
        case 'PASS':
          summary.passed++;
          break;
        case 'SUSPICIOUS':
          summary.suspicious++;
          break;
        case 'HALLUCINATION':
          summary.hallucinated++;
          break;
      }
    }
    summary.durationMs = Math.round(performance.now() - startTime);
    if (!options.quiet) {
      logWatcherResult(summary);
    }
    if (options.onScanComplete) {
      options.onScanComplete(filePath, summary);
    }
    return summary;
  }

  const packages = extractDeps(filePath);
  const isPy = filePath.endsWith('.py') || filePath.endsWith('requirements.txt');
  const registry = isPy ? 'pypi' : 'npm';

  const summary: ScanSummary = {
    filePath,
    total: packages.length,
    passed: 0,
    suspicious: 0,
    hallucinated: 0,
    allowlisted: 0,
    durationMs: 0,
    details: [],
  };

  if (packages.length === 0) {
    summary.durationMs = Math.round(performance.now() - startTime);
    if (options.onScanComplete) {
      options.onScanComplete(filePath, summary);
    }
    return summary;
  }

  const pending: string[] = [];
  const handled: PackageCheckResult[] = [];
  for (const name of packages) {
    if (isAllowed(name) || isInternal(name, path.dirname(filePath))) {
      handled.push({ packageName: name, exists: false });
    } else {
      pending.push(name);
    }
  }

  const results: PackageCheckResult[] = [
    ...handled,
    ...(pending.length > 0 ? await checkPackages(pending, registry) : []),
  ];

  for (const result of results) {
    if (isAllowed(result.packageName) || isInternal(result.packageName, path.dirname(filePath))) {
      const isAllow = isAllowed(result.packageName);
      summary.allowlisted += isAllow ? 1 : 0;
      summary.passed += isAllow ? 0 : 1;
      summary.details.push({
        packageName: result.packageName,
        evaluation: { severity: 'PASS', reasons: [isAllow ? 'allowlisted' : 'internal'] },
        allowlisted: isAllow,
      });
      continue;
    }

    const evaluation = isPy
      ? evaluatePyPiPackage(result.exists, result.data)
      : evaluateNpmPackage(result.exists, result.data);

    summary.details.push({
      packageName: result.packageName,
      evaluation,
      allowlisted: false,
    });

    switch (evaluation.severity) {
      case 'PASS':
        summary.passed++;
        break;
      case 'SUSPICIOUS':
        summary.suspicious++;
        break;
      case 'HALLUCINATION':
        summary.hallucinated++;
        break;
    }
  }

  summary.durationMs = Math.round(performance.now() - startTime);

  if (!options.quiet) {
    logWatcherResult(summary);
  }

  if (options.onScanComplete) {
    options.onScanComplete(filePath, summary);
  }

  return summary;
}

function logWatcherResult(summary: ScanSummary): void {
  const timestamp = new Date().toLocaleTimeString();

  if (summary.hallucinated > 0) {
    console.log('\n' + chalk.bgRed.white.bold(` 🚨 SLOP-STOP INTERCEPTED 🚨 `) + ` ${chalk.dim(`[${timestamp} | ${summary.durationMs}ms]`)}`);
    console.log(chalk.red.bold(`File: ${summary.filePath}`));
    console.log(chalk.red(`Found ${summary.hallucinated} hallucinated (non-existent) package(s):`));
    for (const item of summary.details) {
      if (item.evaluation.severity === 'HALLUCINATION') {
        console.log(`  ${chalk.red('❌')} ${chalk.bold(item.packageName)} ${chalk.dim('(404 Not Found)')}`);
      }
    }
    console.log(chalk.dim(`Action required: Remove these imports immediately. (completed in ${summary.durationMs}ms)\n`));
  } else if (summary.suspicious > 0) {
    console.log('\n' + chalk.bgYellow.black.bold(` ⚠️ SLOP-STOP WARNING ⚠️ `) + ` ${chalk.dim(`[${timestamp} | ${summary.durationMs}ms]`)}`);
    console.log(chalk.yellow.bold(`File: ${summary.filePath}`));
    console.log(chalk.yellow(`Found ${summary.suspicious} suspicious package(s) (high slopsquatting risk):`));
    for (const item of summary.details) {
      if (item.evaluation.severity === 'SUSPICIOUS') {
        console.log(`  ${chalk.yellow('⚠️')} ${chalk.bold(item.packageName)}`);
        for (const reason of item.evaluation.reasons) {
          console.log(`     ${chalk.yellow('→')} ${reason}`);
        }
      }
    }
    console.log(chalk.dim(`Recommendation: Verify package authenticity before running code. (completed in ${summary.durationMs}ms)\n`));
  } else {
    console.log(
      chalk.dim(`[${timestamp}] `) +
        chalk.green('✓') +
        ` Verified ${chalk.cyan(summary.filePath)} (${summary.total} package(s) safe) ` +
        chalk.dim(`[${summary.durationMs}ms]`),
    );
  }
}


export function startWatcher(
  targetDir: string = process.cwd(),
  options: WatcherOptions = {},
): FSWatcher {
  const debounceMs = options.debounceMs ?? 500;
  const timers = new Map<string, NodeJS.Timeout>();

  const watchPatterns = [
    '**/*.js',
    '**/*.jsx',
    '**/*.ts',
    '**/*.tsx',
    '**/*.py',
    '**/package.json',
    '**/requirements.txt',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/poetry.lock',
  ];

  const watcher = chokidar.watch(watchPatterns, {
    cwd: targetDir,
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/.slop-stop.json',
    ],
    ignoreInitial: true,
    persistent: true,
  });

  const handleFileChange = (relativePath: string) => {
    const fullPath = path.resolve(targetDir, relativePath);

    const existing = timers.get(fullPath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      timers.delete(fullPath);
      try {
        await scanFileForWatcher(fullPath, options);
      } catch (err) {
        if (!options.quiet) {
          console.error(chalk.red(`Error scanning file ${relativePath}: ${(err as Error).message}`));
        }
      }
    }, debounceMs);

    timers.set(fullPath, timer);
  };

  watcher.on('add', handleFileChange);
  watcher.on('change', handleFileChange);

  return watcher;
}
