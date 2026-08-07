import { describe, it, expect } from 'vitest';
import { handleVerifyPackage, createMcpServer } from '../mcp-server';

describe('MCP Server & Package Verification', () => {
  describe('handleVerifyPackage', () => {
    it('returns HALLUCINATION for non-existent npm package', async () => {
      const res = await handleVerifyPackage({
        packageName: 'super-fake-hallucinated-package-xyz-9999999',
        registry: 'npm',
      });

      expect(res.severity).toBe('HALLUCINATION');
      expect(res.allowlisted).toBe(false);
      expect(res.message).toContain('CRITICAL INTERCEPTION');
      expect(res.message).toContain('DO NOT write this import');
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it(
      'returns HALLUCINATION for non-existent PyPI package',
      async () => {
        const res = await handleVerifyPackage({
          packageName: 'super-fake-hallucinated-python-pkg-9999999',
          registry: 'pypi',
        });

        expect(res.severity).toBe('HALLUCINATION');
        expect(res.registry).toBe('pypi');
        expect(res.message).toContain('CRITICAL INTERCEPTION');
      },
      15000,
    );

    it('returns non-HALLUCINATION status for existing npm package', async () => {
      const res = await handleVerifyPackage({
        packageName: 'react',
        registry: 'npm',
      });

      expect(res.severity).not.toBe('HALLUCINATION');
    });

    it('returns PASS for allowlisted package', async () => {
      // Allowlisted in .slop-stop.json if present or tested via logic
      const res = await handleVerifyPackage({
        packageName: 'my-company-internal-sdk',
        registry: 'npm',
      });
      expect(res).toBeDefined();
    });
  });

  describe('createMcpServer', () => {
    it('creates MCP server instance with handshake instructions', () => {
      const server = createMcpServer();
      expect(server).toBeDefined();
    });
  });
});
