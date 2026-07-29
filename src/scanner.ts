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

export function extractDeps(filePath: string): string[] {
  const ext = path.extname(filePath);
  const base = path.basename(filePath);

  if (ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx') {
    return extractJsImports(filePath);
  }
  if (ext === '.py') {
    return extractPythonImports(filePath);
  }
  if (base === 'package.json') {
    return extractPackageJsonDeps(filePath);
  }
  if (base === 'requirements.txt') {
    return extractRequirementsTxt(filePath);
  }

  return [];
}

export function extractJsImports(filePath: string): string[] {
  const code = fs.readFileSync(filePath, 'utf-8');
  return extractJsImportsFromCode(code, path.extname(filePath));
}

export function extractJsImportsFromCode(
  code: string,
  ext: string = '.js',
): string[] {
  const packages: Set<string> = new Set();

  let ast: parser.ParseResult<any>;
  try {
    const plugins = [...PLUGINS];
    if (ext === '.ts') {
      plugins.push('decorators-legacy');
    }
    ast = parser.parse(code, {
      sourceType: 'unambiguous',
      plugins,
    });
  } catch {
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

export function extractPythonImports(filePath: string): string[] {
  const code = fs.readFileSync(filePath, 'utf-8');
  return extractPythonImportsFromCode(code);
}

export function extractPythonImportsFromCode(code: string): string[] {
  const packages: Set<string> = new Set();
  const lines = code.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    const importMatch = trimmed.match(/^import\s+(\S+)/);
    if (importMatch) {
      const name = importMatch[1].split('.')[0];
      if (name && !name.startsWith('_')) {
        packages.add(name);
      }
      continue;
    }

    const fromMatch = trimmed.match(/^from\s+(\S+)\s+import/);
    if (fromMatch) {
      const name = fromMatch[1].split('.')[0];
      if (name && !name.startsWith('_')) {
        packages.add(name);
      }
    }
  }

  return Array.from(packages).sort();
}

export function extractPackageJsonDeps(filePath: string): string[] {
  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return extractPackageJsonDepsFromJson(content);
  } catch {
    return [];
  }
}

export function extractPackageJsonDepsFromJson(content: {
  [key: string]: any;
}): string[] {
  const packages: Set<string> = new Set();
  const depFields = ['dependencies', 'devDependencies', 'peerDependencies'];

  for (const field of depFields) {
    if (content[field]) {
      for (const dep of Object.keys(content[field])) {
        packages.add(dep);
      }
    }
  }

  return Array.from(packages).sort();
}

export function extractRequirementsTxt(filePath: string): string[] {
  const code = fs.readFileSync(filePath, 'utf-8');
  return extractRequirementsTxtFromCode(code);
}

export function extractRequirementsTxtFromCode(code: string): string[] {
  const packages: string[] = [];

  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z0-9][\w.-]*)/);
    if (match) {
      packages.push(match[1]);
    }
  }

  return packages.sort();
}
