import { describe, it, expect } from 'vitest';
import { evaluateNpmPackage, evaluatePyPiPackage } from '../heuristics';

describe('evaluateNpmPackage', () => {
  it('returns HALLUCINATION for non-existent packages', () => {
    const result = evaluateNpmPackage(false);
    expect(result.severity).toBe('HALLUCINATION');
    expect(result.reasons).toHaveLength(1);
  });

  it('returns PASS for established packages', () => {
    const result = evaluateNpmPackage(true, {
      time: { created: '2020-01-01T00:00:00.000Z' },
      versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0': {} },
      readme: '# express\n\nFast, unopinionated, minimalist web framework for Node.js. '.repeat(5),
      maintainers: [{ name: 'user1' }, { name: 'user2' }, { name: 'user3' }],
    });
    expect(result.severity).toBe('PASS');
    expect(result.reasons).toHaveLength(0);
  });

  it('returns SUSPICIOUS for brand new packages', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const result = evaluateNpmPackage(true, {
      time: { created: yesterday },
      versions: { '1.0.0': {} },
      readme: '',
      maintainers: [{ name: 'attacker' }],
    });
    expect(result.severity).toBe('SUSPICIOUS');
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.reasons.some((r) => r.includes('created'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('version'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('Readme'))).toBe(true);
  });

  it('flags single version as suspicious', () => {
    const result = evaluateNpmPackage(true, {
      time: { created: '2020-01-01T00:00:00.000Z' },
      versions: { '1.0.0': {} },
      readme: '# pkg\n\nLong enough description here.',
      maintainers: [{ name: 'user1' }, { name: 'user2' }],
    });
    expect(result.severity).toBe('SUSPICIOUS');
    expect(result.reasons.some((r) => r.includes('version'))).toBe(true);
  });

  it('flags empty readme as suspicious', () => {
    const result = evaluateNpmPackage(true, {
      time: { created: '2020-01-01T00:00:00.000Z' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      readme: '',
      maintainers: [{ name: 'user1' }, { name: 'user2' }],
    });
    expect(result.severity).toBe('SUSPICIOUS');
    expect(result.reasons.some((r) => r.includes('Readme'))).toBe(true);
  });

  it('flags single maintainer as suspicious', () => {
    const result = evaluateNpmPackage(true, {
      time: { created: '2020-01-01T00:00:00.000Z' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      readme: '# pkg\n\nLong enough.',
      maintainers: [{ name: 'lonely' }],
    });
    expect(result.severity).toBe('SUSPICIOUS');
    expect(result.reasons.some((r) => r.includes('maintainer'))).toBe(true);
  });
});

describe('evaluatePyPiPackage', () => {
  it('returns HALLUCINATION for non-existent packages', () => {
    const result = evaluatePyPiPackage(false);
    expect(result.severity).toBe('HALLUCINATION');
  });

  it('returns PASS for established packages', () => {
    const result = evaluatePyPiPackage(true, {
      info: {
        created: '2020-01-01T00:00:00.000Z',
        author: 'author',
        description: 'A long description '.repeat(20),
      },
      releases: { '1.0.0': {}, '1.1.0': {}, '2.0.0': {} },
    });
    expect(result.severity).toBe('PASS');
  });

  it('returns SUSPICIOUS for new packages with red flags', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const result = evaluatePyPiPackage(true, {
      info: {
        created: yesterday,
        author: '',
        description: '',
      },
      releases: { '1.0.0': {} },
    });
    expect(result.severity).toBe('SUSPICIOUS');
    expect(result.reasons.some((r) => r.includes('created'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('release'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('Description'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('author'))).toBe(true);
  });
});
