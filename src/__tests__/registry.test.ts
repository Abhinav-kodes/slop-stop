import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import { checkPackageVersion } from '../registry';

describe('registry exact-version validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exists:false when the version 404s', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 404,
      json: async () => ({}),
    } as Response);

    const result = await checkPackageVersion('foo', '999.0.0', 'npm');
    expect(result.exists).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns exists:true with data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      json: async () => ({ name: 'foo', version: '1.0.0' }),
    } as Response);

    const result = await checkPackageVersion('foo', '1.0.0', 'npm');
    expect(result.exists).toBe(true);
    expect(result.data).toEqual({ name: 'foo', version: '1.0.0' });
  });

  it('builds pypi version URLs as /pypi/<name>/<version>/json', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      json: async () => ({}),
    } as Response);

    await checkPackageVersion('requests', '2.31.0', 'pypi');
    const url = (fetchSpy.mock.calls[0][0] as string);
    expect(url).toBe('https://pypi.org/pypi/requests/2.31.0/json');
  });

  it('fails open with error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await checkPackageVersion('network-fail-pkg', '9.9.9', 'npm');
    expect(result.exists).toBe(false);
    expect(result.error).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});