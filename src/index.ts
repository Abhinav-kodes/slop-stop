#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { extractJsImports } from './scanner';

const program = new Command();

program
  .name('slop-stop')
  .description('Stop AI agents from importing fake packages.')
  .version('1.0.0');

program
  .command('check')
  .description('Check a file for hallucinated package imports')
  .argument('<file>', 'path to the file to check')
  .action((file: string) => {
    console.log(chalk.blue(`Checking ${file}...`));
    const packages = extractJsImports(file);
    if (packages.length === 0) {
      console.log(chalk.green('No third-party package imports found.'));
    } else {
      console.log(chalk.yellow('Packages found:'));
      packages.forEach((pkg) => console.log(`  ${pkg}`));
    }
  });

program.parse(process.argv);
