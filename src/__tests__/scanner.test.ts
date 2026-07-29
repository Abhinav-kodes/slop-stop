import { describe, it, expect } from 'vitest';
import {
  extractJsImportsFromCode,
  extractPythonImportsFromCode,
  extractPackageJsonDepsFromJson,
  extractRequirementsTxtFromCode,
} from '../scanner';

describe('extractJsImportsFromCode', () => {
  it('extracts named imports', () => {
    const result = extractJsImportsFromCode(`import { useState } from 'react';`);
    expect(result).toEqual(['react']);
  });

  it('extracts default imports', () => {
    const result = extractJsImportsFromCode(`import express from 'express';`);
    expect(result).toEqual(['express']);
  });

  it('extracts namespace imports', () => {
    const result = extractJsImportsFromCode(`import * as lodash from 'lodash';`);
    expect(result).toEqual(['lodash']);
  });

  it('extracts require() calls', () => {
    const result = extractJsImportsFromCode(`const fs = require('fs');`);
    expect(result).toEqual(['fs']);
  });

  it('handles scoped packages', () => {
    const result = extractJsImportsFromCode(
      `import { createClient } from '@supabase/supabase-js';`,
    );
    expect(result).toEqual(['@supabase/supabase-js']);
  });

  it('filters out relative imports', () => {
    const code = `
      import { foo } from './utils';
      import bar from '../helpers';
      import baz from '/absolute/path';
    `;
    const result = extractJsImportsFromCode(code);
    expect(result).toEqual([]);
  });

  it('extracts multiple packages and sorts them', () => {
    const code = `
      import express from 'express';
      import lodash from 'lodash';
      import react from 'react';
    `;
    const result = extractJsImportsFromCode(code);
    expect(result).toEqual(['express', 'lodash', 'react']);
  });

  it('does not duplicate packages', () => {
    const code = `
      import express from 'express';
      import type { Request } from 'express';
    `;
    const result = extractJsImportsFromCode(code);
    expect(result).toEqual(['express']);
  });

  it('handles empty code', () => {
    const result = extractJsImportsFromCode('');
    expect(result).toEqual([]);
  });

  it('returns empty array on parse error', () => {
    const result = extractJsImportsFromCode('??? invalid javascript ???');
    expect(result).toEqual([]);
  });
});

describe('extractPythonImportsFromCode', () => {
  it('extracts simple imports', () => {
    const result = extractPythonImportsFromCode('import flask');
    expect(result).toEqual(['flask']);
  });

  it('extracts from X import Y', () => {
    const result = extractPythonImportsFromCode('from requests import get');
    expect(result).toEqual(['requests']);
  });

  it('extracts multiple imports from different statements', () => {
    const result = extractPythonImportsFromCode(`
      import flask
      from requests import get
      import numpy as np
    `);
    expect(result).toEqual(['flask', 'numpy', 'requests']);
  });

  it('strips submodule from dotted imports', () => {
    const result = extractPythonImportsFromCode('import os.path');
    expect(result).toEqual(['os']);
  });

  it('strips submodule from dotted from-imports', () => {
    const result = extractPythonImportsFromCode('from os.path import join');
    expect(result).toEqual(['os']);
  });

  it('filters out stdlib-like private modules', () => {
    const result = extractPythonImportsFromCode('import _internal');
    expect(result).toEqual([]);
  });

  it('handles conditional imports in try/except', () => {
    const code = `
      try:
        import uvloop
      except ImportError:
        import asyncio
    `;
    const result = extractPythonImportsFromCode(code);
    expect(result).toEqual(['asyncio', 'uvloop']);
  });

  it('handles imports inside functions', () => {
    const code = `
      def lazy_load():
          import tensorflow
          return tensorflow.constant(1)
    `;
    const result = extractPythonImportsFromCode(code);
    expect(result).toEqual(['tensorflow']);
  });

  it('handles empty code', () => {
    const result = extractPythonImportsFromCode('');
    expect(result).toEqual([]);
  });

  it('handles comments and blank lines', () => {
    const code = `
      # This is a comment
      import flask

      # Another comment
      from requests import get
    `;
    const result = extractPythonImportsFromCode(code);
    expect(result).toEqual(['flask', 'requests']);
  });
});

describe('extractPackageJsonDepsFromJson', () => {
  it('extracts from dependencies', () => {
    const result = extractPackageJsonDepsFromJson({
      dependencies: { express: '^4.18.0', react: '^18.0.0' },
    });
    expect(result).toEqual(['express', 'react']);
  });

  it('extracts from devDependencies', () => {
    const result = extractPackageJsonDepsFromJson({
      devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
    });
    expect(result).toEqual(['typescript', 'vitest']);
  });

  it('extracts from peerDependencies', () => {
    const result = extractPackageJsonDepsFromJson({
      peerDependencies: { react: '^18.0.0' },
    });
    expect(result).toEqual(['react']);
  });

  it('merges all dep fields sorted', () => {
    const result = extractPackageJsonDepsFromJson({
      dependencies: { zeta: '1.0.0' },
      devDependencies: { alpha: '1.0.0' },
      peerDependencies: { beta: '1.0.0' },
    });
    expect(result).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('returns empty for empty object', () => {
    const result = extractPackageJsonDepsFromJson({});
    expect(result).toEqual([]);
  });

  it('handles scoped packages', () => {
    const result = extractPackageJsonDepsFromJson({
      dependencies: { '@scope/pkg': '1.0.0' },
    });
    expect(result).toEqual(['@scope/pkg']);
  });

  it('ignores non-dep fields', () => {
    const result = extractPackageJsonDepsFromJson({
      name: 'test',
      scripts: { build: 'tsc' },
    });
    expect(result).toEqual([]);
  });
});

describe('extractRequirementsTxtFromCode', () => {
  it('extracts simple package names', () => {
    const result = extractRequirementsTxtFromCode('flask==2.3.0');
    expect(result).toEqual(['flask']);
  });

  it('extracts multiple packages with version specifiers', () => {
    const result = extractRequirementsTxtFromCode(`
      flask==2.3.0
      requests>=2.31.0
      numpy~=1.24
    `);
    expect(result).toEqual(['flask', 'numpy', 'requests']);
  });

  it('ignores comments and blank lines', () => {
    const result = extractRequirementsTxtFromCode(`
      # This is a comment
      flask==2.3.0

      requests>=2.31.0
    `);
    expect(result).toEqual(['flask', 'requests']);
  });

  it('ignores option flags', () => {
    const result = extractRequirementsTxtFromCode(`
      --index-url https://example.com
      flask==2.3.0
    `);
    expect(result).toEqual(['flask']);
  });

  it('handles packages with underscores and dots', () => {
    const result = extractRequirementsTxtFromCode('my_package==1.0.0');
    expect(result).toEqual(['my_package']);
  });

  it('returns empty for empty input', () => {
    const result = extractRequirementsTxtFromCode('');
    expect(result).toEqual([]);
  });

  it('returns empty for only comments', () => {
    const result = extractRequirementsTxtFromCode('# just a comment');
    expect(result).toEqual([]);
  });
});
