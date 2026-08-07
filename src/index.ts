#!/usr/bin/env node

import * as fs from 'fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { extractDeps } from './scanner';
import { checkPackages } from './registry';
import { evaluateNpmPackage, evaluatePyPiPackage } from './heuristics';
import { isAllowed } from './config';

import * as path from 'path';
import { startWatcher } from './watcher';
import { installGitHook, checkStagedFiles } from './hook';

const program = new Command();

program
  .name('slop-stop')
  .description('Stop AI agents from importing fake packages.')
  .version('1.0.0');

program
  .command('check')
  .description('Check a file for hallucinated package imports')
  .argument('<file>', 'path to the file to check')
  .action(async (file: string) => {
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

    console.log();
    if (hallucinationCount > 0) {
      console.log(chalk.red(`Found ${hallucinationCount} hallucinated package(s).`));
    }
    if (suspiciousCount > 0) {
      console.log(chalk.yellow(`Found ${suspiciousCount} suspicious package(s) (possible slopsquatting).`));
    }
    if (hallucinationCount === 0 && suspiciousCount === 0) {
      console.log(chalk.green('All packages verified on registry.'));
    }
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

if (require.main === module) {
  program.parse(process.argv);
}


