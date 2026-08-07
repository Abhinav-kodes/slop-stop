import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { checkNpmPackage, checkPyPiPackage, PackageCheckResult } from './registry';
import { evaluateNpmPackage, evaluatePyPiPackage, EvaluationResult } from './heuristics';
import { isAllowed } from './config';

export interface VerifyPackageRequest {
  packageName: string;
  registry?: 'npm' | 'pypi';
}

export interface VerifyPackageResponse {
  packageName: string;
  registry: 'npm' | 'pypi';
  severity: 'PASS' | 'SUSPICIOUS' | 'HALLUCINATION';
  allowlisted: boolean;
  message: string;
  reasons: string[];
  durationMs: number;
}

export async function handleVerifyPackage(
  req: VerifyPackageRequest,
): Promise<VerifyPackageResponse> {
  const startTime = performance.now();
  const packageName = req.packageName.trim();
  const registry = req.registry || 'npm';

  if (isAllowed(packageName)) {
    const durationMs = Math.round(performance.now() - startTime);
    return {
      packageName,
      registry,
      severity: 'PASS',
      allowlisted: true,
      message: `Package '${packageName}' is explicitly allowlisted in project configuration. Safe to import.`,
      reasons: ['allowlisted'],
      durationMs,
    };
  }

  const checkResult: PackageCheckResult =
    registry === 'pypi'
      ? await checkPyPiPackage(packageName)
      : await checkNpmPackage(packageName);

  const evaluation: EvaluationResult =
    registry === 'pypi'
      ? evaluatePyPiPackage(checkResult.exists, checkResult.data)
      : evaluateNpmPackage(checkResult.exists, checkResult.data);

  const durationMs = Math.round(performance.now() - startTime);

  let message = '';
  switch (evaluation.severity) {
    case 'HALLUCINATION':
      message = `CRITICAL INTERCEPTION: Package '${packageName}' DOES NOT EXIST on ${registry} (404 Not Found). DO NOT write this import statement. It is an AI hallucination.`;
      break;
    case 'SUSPICIOUS':
      message = `WARNING: Package '${packageName}' exists on ${registry} but shows severe slopsquatting red flags:\n${evaluation.reasons.map((r) => `  • ${r}`).join('\n')}\nHigh malware risk. Strongly consider finding an established alternative.`;
      break;
    case 'PASS':
      message = `Package '${packageName}' is verified on ${registry} and safe to import.`;
      break;
  }

  return {
    packageName,
    registry,
    severity: evaluation.severity,
    allowlisted: false,
    message,
    reasons: evaluation.reasons,
    durationMs,
  };
}

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'slop-stop',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'RULE: Before writing any third-party package import statement in code or manifest files, you MUST call the verify_package tool first to verify that the package exists on the registry and is safe.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'verify_package',
        description:
          'Checks if an npm or PyPI package actually exists and is safe to use. You MUST call this BEFORE writing any third-party import statement.',
        inputSchema: {
          type: 'object',
          properties: {
            packageName: {
              type: 'string',
              description: 'The exact package name to check (e.g. lodash, express, requests)',
            },
            registry: {
              type: 'string',
              enum: ['npm', 'pypi'],
              default: 'npm',
              description: 'The target package registry (npm for JS/TS, pypi for Python)',
            },
          },
          required: ['packageName'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'verify_package') {
      const { packageName, registry } = (args || {}) as unknown as VerifyPackageRequest;

      if (!packageName) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Error: packageName parameter is required.',
            },
          ],
        };
      }

      const res = await handleVerifyPackage({ packageName, registry });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unknown tool: ${name}`,
        },
      ],
    };
  });

  return server;
}

export async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
