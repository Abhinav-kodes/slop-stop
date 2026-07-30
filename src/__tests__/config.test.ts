import { describe, it, expect, beforeEach } from 'vitest';
import { isAllowed, getMaxAgeDays } from '../config';

beforeEach(() => {
  process.env.HOME = '/tmp';
});

describe('config', () => {
  it('isAllowed returns false when no config file exists', () => {
    const result = isAllowed('express');
    expect(result).toBe(false);
  });

  it('getMaxAgeDays returns default value', () => {
    const result = getMaxAgeDays();
    expect(result).toBe(14);
  });
});
