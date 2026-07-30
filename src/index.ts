#!/usr/bin/env node

import * as fs from 'fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { extractDeps } from './scanner';
import { checkPackages } from './registry';
import { evaluateNpmPackage, evaluatePyPiPackage } from './heuristics';
import { isAllowed } from './config';

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

if (require.main === module) {
  program.parse(process.argv);
}
