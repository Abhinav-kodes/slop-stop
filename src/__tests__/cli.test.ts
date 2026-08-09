import { describe, it, expect } from 'vitest';

describe('CLI entry point', () => {
  it('should export the program', async () => {
    const cli = await import('../index');
    expect(cli).toBeDefined();
  });

  it('registers the check-drift command', async () => {
    const { program } = await import('../index');
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('check-drift');
  });
});
