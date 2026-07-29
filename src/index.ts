#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { extractJsImports } from './scanner';
import { checkNpmPackage } from './registry';

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
    console.log(chalk.blue(`Checking ${file}...`));
    const packages = extractJsImports(file);
    if (packages.length === 0) {
      console.log(chalk.green('No third-party package imports found.'));
      return;
    }

    const results = await Promise.all(
      packages.map((pkg) => checkNpmPackage(pkg))
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
        chalk.red(`⚠ Found ${hallucinationCount} hallucinated package(s).`)
      );
    } else {
      console.log(chalk.green('All packages verified on npm.'));
    }
  });

if (require.main === module) {
  program.parse(process.argv);
}
