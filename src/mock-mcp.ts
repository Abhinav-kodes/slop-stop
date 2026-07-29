import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const FAKE_PACKAGES = new Set(['axios-fake-utils', 'react-lodash-utils']);

const server = new Server(
  { name: 'slop-stop-mock', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'verify_package',
      description:
        'Checks if an npm or PyPI package actually exists. Call this BEFORE writing any import statement for a third-party package.',
      inputSchema: {
        type: 'object',
        properties: {
          packageName: { type: 'string' },
          registry: { type: 'string', enum: ['npm', 'pypi'] },
        },
        required: ['packageName', 'registry'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { packageName } = request.params.arguments as {
    packageName: string;
    registry: string;
  };

  const exists = !FAKE_PACKAGES.has(packageName);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ packageName, exists, mock: true }),
      },
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
