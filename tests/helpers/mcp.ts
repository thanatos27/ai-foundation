import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../../src/config/loader.js';
import type { Config } from '../../src/config/schema.js';
import type { Connectors } from '../../src/connectors/types.js';
import { createServer } from '../../src/server.js';

export const repoConfig = await loadConfig(fileURLToPath(new URL('../../config.yaml', import.meta.url)));

/** Connects an in-memory MCP client to a fully registered server. Close it after the test. */
export async function connectClient(connectors: Connectors, config: Config = repoConfig): Promise<Client> {
  const server = createServer({ config, connectors });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Text of the first content block of a tool result. */
export function resultText(result: { content?: unknown }): string {
  const [first] = (result.content ?? []) as { type: string; text?: string }[];
  return first?.text ?? '';
}
