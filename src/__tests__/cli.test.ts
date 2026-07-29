import { describe, it, expect } from 'vitest';

describe('CLI entry point', () => {
  it('should export the program', async () => {
    const cli = await import('../index');
    expect(cli).toBeDefined();
  });
});
