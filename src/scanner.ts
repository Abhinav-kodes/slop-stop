import * as fs from 'fs';
import * as path from 'path';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import type { ImportDeclaration, CallExpression } from '@babel/types';

const PLUGINS: parser.ParserPlugin[] = [
  'jsx',
  'typescript',
  'decorators-legacy',
  'dynamicImport',
];

export function extractJsImports(filePath: string): string[] {
  const code = fs.readFileSync(filePath, 'utf-8');
  const packages: Set<string> = new Set();

  let ast: parser.ParseResult<any>;
  try {
    const ext = path.extname(filePath);
    const plugins = [...PLUGINS];
    if (ext === '.ts') {
      plugins.push('decorators-legacy');
    }
    ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins,
    });
  } catch (e) {
    console.error(`Failed to parse ${filePath}:`, (e as Error).message);
    return [];
  }

  traverse(ast, {
    ImportDeclaration(nodePath) {
      const node = nodePath.node as ImportDeclaration;
      const source = node.source.value;
      if (source && !source.startsWith('.') && !source.startsWith('/')) {
        packages.add(source);
      }
    },
    CallExpression(nodePath) {
      const node = nodePath.node as CallExpression;
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'StringLiteral'
      ) {
        const source = node.arguments[0].value;
        if (!source.startsWith('.') && !source.startsWith('/')) {
          packages.add(source);
        }
      }
    },
  });

  return Array.from(packages).sort();
}
