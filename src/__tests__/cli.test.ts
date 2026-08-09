import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('CLI entry point', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should export the program', async () => {
    const cli = await import('../index');
    expect(cli).toBeDefined();
  });

  it('registers the check-drift command', async () => {
    const { program } = await import('../index');
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('check-drift');
  });

  it('`check` flags a fake package as hallucinated', async () => {
    const { program } = await import('../index');
    const fixturePath = path.join(tmpDir, 'fixture.js');
    fs.writeFileSync(
      fixturePath,
      "import fake from 'super-fake-cli-check-pkg-4444';",
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 404,
      json: async () => ({}),
    } as Response);
    const logSpy = vi.spyOn(console, 'log');

    await program.parseAsync(['check', fixturePath], { from: 'user' });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('[HALLUCINATION]');
    expect(output).toContain('super-fake-cli-check-pkg-4444');
  });
});