#!/usr/bin/env node

import * as fs from 'fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { extractDeps } from './scanner';
import { checkNpmPackage, checkPyPiPackage } from './registry';
import type { PackageCheckResult } from './registry';

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

    const results: PackageCheckResult[] = await Promise.all(
      packages.map((pkg) => {
        if (file.endsWith('.py') || file.endsWith('requirements.txt')) {
          return checkPyPiPackage(pkg);
        }
        return checkNpmPackage(pkg);
      })
    );

    let hallucinationCount = 0;
    for (const result of results) {
      if (result.exists) {
        console.log(`  ${chalk.green('[PASS]')} ${result.packageName}`);
      } else {
        console.log(`  ${chalk.red('[HALLUCINATION]')} ${result.packageName}`);
        hallucinationCount++;
      }
    }

    console.log();
    if (hallucinationCount > 0) {
      console.log(
        chalk.red(`Found ${hallucinationCount} hallucinated package(s).`)
      );
    } else {
      console.log(chalk.green('All packages verified on registry.'));
    }
  });

if (require.main === module) {
  program.parse(process.argv);
}
