import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import type { Connectors } from '../../src/connectors/types.js';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../src/errors.js';
import { createServer } from '../../src/server.js';
import { FakeKnowledgeConnector, FakeLifeLogConnector } from '../helpers/fake-connectors.js';
import { connectClient, repoConfig, resultText } from '../helpers/mcp.js';

const ID = 'lifelog:2026-10-03-東京散策.md';
const LIFELOG = {
  id: ID,
  type: 'lifelog',
  date: '2026-10-03',
  title: '東京散策',
  source: 'obsidian',
  external_ref: 'AI Foundation/LifeLog/2026-10-03-東京散策.md',
};

let connector: FakeLifeLogConnector;
let client: Client;

beforeEach(async () => {
  connector = new FakeLifeLogConnector();
  client = await connectClient({ lifelog: connector });
});

afterEach(async () => {
  await client.close();
});

async function connectWith(config: Config, connectors: Connectors): Promise<Client> {
  const server = createServer({ config, connectors });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const other = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), other.connect(clientTransport)]);
  return other;
}

describe('lifelog tools', () => {
  it('lists the three life log tools with their schemas and annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const create = byName.lifelog_create;
    expect(create?.inputSchema).toMatchObject({ required: ['date', 'title', 'content'], additionalProperties: false });
    expect(create?.description).toContain('knowledge_create');
    expect(create?.description).toContain('YYYY-MM-DD-<title>.md');
    expect(create?.description).toContain('never overwritten');
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });

    const get = byName.lifelog_get;
    expect(get?.inputSchema).toMatchObject({ required: ['id'], additionalProperties: false });
    expect(get?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

    const append = byName.lifelog_append;
    expect(append?.inputSchema).toMatchObject({ required: ['id', 'content'], additionalProperties: false });
    expect(append?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });

    for (const tool of [get, append]) {
      // No list or search: the id comes from lifelog_create or the exact file name, and the limit is stated.
      expect(tool?.description).toContain('"lifelog:" followed by the file name');
      expect(tool?.description).toContain('no tool to list or search');
      expect(tool?.description).toContain('cannot be reached');
    }
    for (const tool of [create, get, append]) expect(tool?.outputSchema).toBeDefined();
  });

  it('creates an article from a date, a title and content as given', async () => {
    const args = { date: '2026-10-03', title: '東京散策', content: '# 東京散策\n\n浅草。' };
    const result = await client.callTool({ name: 'lifelog_create', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'create', arg: args }]);
    expect(result.structuredContent).toEqual({ lifelog: LIFELOG });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it('gets an article with its content', async () => {
    connector.content = '# 東京散策\n';
    const result = await client.callTool({ name: 'lifelog_get', arguments: { id: ID } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'get', arg: ID }]);
    expect(result.structuredContent).toEqual({ lifelog: LIFELOG, content: '# 東京散策\n' });
  });

  it('appends to an article', async () => {
    const result = await client.callTool({ name: 'lifelog_append', arguments: { id: ID, content: '夕食' } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'append', arg: { id: ID, content: '夕食' } }]);
    expect(result.structuredContent).toEqual({ lifelog: LIFELOG });
  });

  it.each([
    ['an impossible date', 'lifelog_create', { date: '2026-02-30', title: 't', content: 'c' }],
    ['a date with time', 'lifelog_create', { date: '2026-10-03T10:00:00+09:00', title: 't', content: 'c' }],
    ['a blank title', 'lifelog_create', { date: '2026-10-03', title: ' ', content: 'c' }],
    ['blank content', 'lifelog_create', { date: '2026-10-03', title: 't', content: '\n' }],
    ['tags', 'lifelog_create', { date: '2026-10-03', title: 't', content: 'c', tags: ['旅行'] }],
    ['no id', 'lifelog_get', {}],
    ['blank content', 'lifelog_append', { id: ID, content: '  ' }],
  ])('rejects %s for %s', async (_label, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(connector.calls).toEqual([]);
  });

  it('reports a configuration error when sources.lifelog is missing', async () => {
    const { lifelog: _lifelog, ...sources } = repoConfig.sources;
    const other = await connectWith({ ...repoConfig, sources }, { lifelog: connector });
    try {
      for (const call of [
        { name: 'lifelog_create', arguments: { date: '2026-10-03', title: 't', content: 'c' } },
        { name: 'lifelog_get', arguments: { id: ID } },
        { name: 'lifelog_append', arguments: { id: ID, content: 'c' } },
      ]) {
        const result = await other.callTool(call);
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain('Configuration error: sources.lifelog is not configured');
      }
      expect(connector.calls).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('reports a configuration error when no connector is wired', async () => {
    const other = await connectWith(repoConfig, {});
    try {
      const result = await other.callTool({ name: 'lifelog_get', arguments: { id: ID } });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Configuration error: the life log source (Obsidian) is not configured');
    } finally {
      await other.close();
    }
  });

  it.each([
    new ConfigurationError('sources.lifelog.obsidian.directory is not set'),
    new InputValidationError(`life log "${ID}" already exists; choose another title, or use lifelog_append to add to it`),
    new NotFoundError(`life log "${ID}" was not found`),
    new ProviderApiError('Obsidian', `life log "${ID}" is not valid UTF-8; fix it in Obsidian`),
  ])('returns the connector error as a tool error: %s', async (error) => {
    connector.failWith = error;
    const result = await client.callTool({ name: 'lifelog_append', arguments: { id: ID, content: 'c' } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(error.message);
  });

  it('keeps the knowledge tools independent of the life log tools', async () => {
    const knowledge = new FakeKnowledgeConnector();
    const other = await connectWith(repoConfig, { knowledge });
    try {
      expect((await other.callTool({ name: 'knowledge_search', arguments: {} })).isError).toBeFalsy();
      expect((await other.callTool({ name: 'lifelog_get', arguments: { id: ID } })).isError).toBe(true);
    } finally {
      await other.close();
    }
  });
});
