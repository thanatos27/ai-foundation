import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config/loader.js';
import { INSTRUCTIONS } from '../src/instructions.js';
import { SERVER_INFO, createServer } from '../src/server.js';
import type { ToolContext } from '../src/tools/index.js';

const config = await loadConfig(fileURLToPath(new URL('../config.yaml', import.meta.url)));
const context: ToolContext = { config, connectors: {} };

/** Test-only tools, registered the same way Phase 2 entity tools will be. */
function registerTestTools(server: McpServer, { config }: ToolContext): void {
  server.registerTool(
    'test_echo',
    { description: 'Echoes the message with the configured time zone.', inputSchema: z.object({ message: z.string() }) },
    async ({ message }) => ({ content: [{ type: 'text', text: `${message} @ ${config.defaults.timezone}` }] }),
  );
  server.registerTool(
    'test_fail',
    { description: 'Always throws.' },
    async () => {
      throw new Error('boom');
    },
  );
}

const clients: Client[] = [];

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('createServer', () => {
  it('exposes server info and instructions', async () => {
    const client = await connect(createServer(context));
    expect(client.getServerVersion()).toMatchObject(SERVER_INFO);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it('lists the task, schedule and collection tools', async () => {
    const client = await connect(createServer(context));
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'collection_create',
      'collection_search',
      'collection_update',
      'schedule_create',
      'schedule_list',
      'task_complete',
      'task_create',
      'task_list',
      'task_update',
    ]);
  });
});

describe('tool registration (test-only tools)', () => {
  async function connectWithTestTools(): Promise<Client> {
    const server = createServer(context);
    registerTestTools(server, context);
    return connect(server);
  }

  it('lists registered tools with their input schema', async () => {
    const client = await connectWithTestTools();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('test_')).sort()).toEqual([
      'test_echo',
      'test_fail',
    ]);
    const echo = tools.find((tool) => tool.name === 'test_echo');
    expect(echo?.inputSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it('calls a tool that reads the ToolContext', async () => {
    const client = await connectWithTestTools();
    const result = await client.callTool({ name: 'test_echo', arguments: { message: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'hello @ Asia/Tokyo' }]);
  });

  it('returns a tool error for invalid input', async () => {
    const client = await connectWithTestTools();
    const result = await client.callTool({ name: 'test_echo', arguments: { message: 42 } });
    expect(result.isError).toBe(true);
  });

  it('returns a tool error when the handler throws, and keeps serving', async () => {
    const client = await connectWithTestTools();
    const failed = await client.callTool({ name: 'test_fail', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('boom');

    const ok = await client.callTool({ name: 'test_echo', arguments: { message: 'still alive' } });
    expect(ok.isError).toBeFalsy();
  });

  it('rejects a duplicate tool name at registration', () => {
    const server = createServer(context);
    registerTestTools(server, context);
    expect(() => registerTestTools(server, context)).toThrow(/test_echo/);
  });
});
