#!/usr/bin/env node

import * as fs from 'fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { extractDeps } from './scanner';
import { checkPackages } from './registry';
import { evaluateNpmPackage, evaluatePyPiPackage } from './heuristics';
import { isAllowed, isInternal } from './config';

import * as path from 'path';
import { startWatcher } from './watcher';
import { installGitHook, checkStagedFiles } from './hook';
import { LOCKFILE_BASENAMES } from './lockfiles';
import { checkDrift, verifyLockfileVersions, LockfileVersionViolation } from './drift';
import { hasPrivateRegistry } from './registry-config';

export const program = new Command();

program
  .name('slop-stop')
  .description('Stop AI agents from importing fake packages.')
  .version('1.0.0');

program
  .command('check')
  .description('Check a file for hallucinated package imports')
  .argument('<file>', 'path to the file to check')
  .action(async (file: string) => {
    const startTime = performance.now();
    if (!fs.existsSync(file)) {
      console.log(chalk.red(`File not found: ${file}`));
      process.exit(1);
    }

    console.log(chalk.blue(`Checking ${file}...`));
    const packages = extractDeps(file);
    if (packages.length === 0) {
      console.log(chalk.green('No third-party packages found.'));
      return;
    }

    const isPy = file.endsWith('.py') || file.endsWith('requirements.txt');
    const registry = isPy ? 'pypi' : 'npm';
    const results = await checkPackages(packages, registry);

    let hallucinationCount = 0;
    let suspiciousCount = 0;

    for (const result of results) {
      if (isAllowed(result.packageName)) {
        console.log(`  ${chalk.green('[PASS]')} ${result.packageName} ${chalk.dim('(allowlisted)')}`);
        continue;
      }

      const evaluation = isPy
        ? evaluatePyPiPackage(result.exists, result.data)
        : evaluateNpmPackage(result.exists, result.data);

      switch (evaluation.severity) {
        case 'PASS':
          console.log(`  ${chalk.green('[PASS]')} ${result.packageName}`);
          break;
        case 'SUSPICIOUS':
          console.log(`  ${chalk.yellow('[SUSPICIOUS]')} ${result.packageName}`);
          for (const reason of evaluation.reasons) {
            console.log(`    ${chalk.yellow('→')} ${reason}`);
          }
          suspiciousCount++;
          break;
        case 'HALLUCINATION':
          console.log(`  ${chalk.red('[HALLUCINATION]')} ${result.packageName}`);
          hallucinationCount++;
          break;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    console.log();
    if (hallucinationCount > 0) {
      console.log(chalk.red(`Found ${hallucinationCount} hallucinated package(s).`) + chalk.dim(` [${durationMs}ms]`));
    }
    if (suspiciousCount > 0) {
      console.log(chalk.yellow(`Found ${suspiciousCount} suspicious package(s) (possible slopsquatting).`) + chalk.dim(` [${durationMs}ms]`));
    }
    if (hallucinationCount === 0 && suspiciousCount === 0) {
      console.log(chalk.green('All packages verified on registry.') + chalk.dim(` [${durationMs}ms]`));
    }
  });


program
  .command('check-drift')
  .description('Check manifest vs lockfile drift and verify resolved lockfile versions')
  .argument('[directory]', 'target directory', '.')
  .action(async (directory: string) => {
    const startTime = performance.now();
    const targetDir = path.resolve(directory);
    if (!fs.existsSync(targetDir)) {
      console.log(chalk.red(`Directory not found: ${targetDir}`));
      process.exit(1);
    }

    const report = checkDrift(targetDir);
    const lockfiles = LOCKFILE_BASENAMES
      .map((name) => path.join(targetDir, name))
      .filter((file) => fs.existsSync(file));

    if (report.packages.length === 0 && lockfiles.length === 0) {
      console.log(chalk.green('No manifest or lockfile found in directory.') + chalk.dim(` [${Math.round(performance.now() - startTime)}ms]`));
      return;
    }

    const checks: LockfileVersionViolation[] = [];
    for (const lockfile of lockfiles) {
      checks.push(...await verifyLockfileVersions(lockfile, targetDir));
    }

    let suspiciousCount = report.suspiciousCount;
    let hallucinationCount = 0;

    console.log(chalk.blue(`Checking drift in ${targetDir}...`));

    for (const pkg of report.packages) {
      const statusColor = pkg.severity === 'SUSPICIOUS'
        ? chalk.yellow(`[${pkg.severity}]`)
        : chalk.green(`[${pkg.severity}]`);
      console.log(`  ${chalk.bold(pkg.name)} ${chalk.dim(pkg.manifestRange ?? '-')} → ${chalk.dim(pkg.lockfileVersion ?? '-')} ${statusColor}`);
      for (const reason of pkg.reasons) {
        console.log(`    ${chalk.dim('→')} ${reason}`);
      }
    }

    for (const check of checks) {
      switch (check.severity) {
        case 'PASS':
          console.log(`  ${chalk.green('[PASS]')} ${check.packageName}@${check.version}`);
          break;
        case 'SUSPICIOUS':
          console.log(`  ${chalk.yellow('[SUSPICIOUS]')} ${check.packageName}@${check.version}`);
          for (const reason of check.reasons) {
            console.log(`    ${chalk.yellow('→')} ${reason}`);
          }
          suspiciousCount++;
          break;
        case 'HALLUCINATION':
          console.log(`  ${chalk.red('[HALLUCINATION]')} ${check.packageName}@${check.version}`);
          for (const reason of check.reasons) {
            console.log(`    ${chalk.red('→')} ${reason}`);
          }
          hallucinationCount++;
          break;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    console.log();
    if (hallucinationCount > 0) {
      console.log(chalk.red(`Found ${hallucinationCount} locked version(s) that do not exist on the registry.`) + chalk.dim(` [${durationMs}ms]`));
      process.exit(1);
    }
    if (suspiciousCount > 0) {
      console.log(chalk.yellow(`Found ${suspiciousCount} drift or version issue(s).`) + chalk.dim(` [${durationMs}ms]`));
      return;
    }
    console.log(chalk.green('No drift detected. All locked versions verified.') + chalk.dim(` [${durationMs}ms]`));
  });


program
  .command('watch')
  .description('Monitor workspace in real-time for AI-generated package imports')
  .argument('[directory]', 'directory path to watch', '.')
  .option('-d, --debounce <ms>', 'debounce time in milliseconds', '500')
  .action((directory: string, options: { debounce: string }) => {
    const targetDir = path.resolve(directory);
    if (!fs.existsSync(targetDir)) {
      console.log(chalk.red(`Directory not found: ${targetDir}`));
      process.exit(1);
    }

    const debounceMs = parseInt(options.debounce, 10) || 500;

    console.log(chalk.bgCyan.black.bold(' 👁️ SLOP-STOP WATCHER ACTIVE 👁️ '));
    console.log(chalk.cyan(`Watching ${chalk.bold(targetDir)} for file changes...`));
    console.log(chalk.dim(`Debounce: ${debounceMs}ms | Press Ctrl+C to exit\n`));

    const watcher = startWatcher(targetDir, { debounceMs });

    const shutdown = () => {
      console.log(chalk.yellow('\nStopping watcher...'));
      watcher.close().then(() => {
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('install-hook')
  .description('Install Slop-Stop pre-commit hook into git repository (Husky or native)')
  .argument('[directory]', 'target git repository directory', '.')
  .action((directory: string) => {
    try {
      const result = installGitHook(path.resolve(directory));
      console.log(chalk.green(`✓ ${result.message}`));
    } catch (err) {
      console.error(chalk.red(`Error installing git hook: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command('check-staged')
  .description('Check staged git files for hallucinated packages (used by pre-commit hook)')
  .argument('[directory]', 'target git repository directory', '.')
  .action(async (directory: string) => {
    try {
      const result = await checkStagedFiles(path.resolve(directory));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(chalk.red(`Error checking staged files: ${(err as Error).message}`));
      process.exit(1);
    }
  });

import { main as runMcpServer } from './mcp-server';

program
  .command('mcp')
  .description('Launch the Slop-Stop MCP Server over stdio transport')
  .action(async () => {
    try {
      await runMcpServer();
    } catch (err) {
      console.error('Failed to start MCP server:', err);
      process.exit(1);
    }
  });

if (require.main === module) {
  program.parse(process.argv);
}



