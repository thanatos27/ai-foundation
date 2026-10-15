import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import type { Connectors } from '../../src/connectors/types.js';
import { CredentialError, NotFoundError, ProviderApiError } from '../../src/errors.js';
import { createServer } from '../../src/server.js';
import { FakeProjectConnector } from '../helpers/fake-connectors.js';
import { connectClient, repoConfig, resultText } from '../helpers/mcp.js';

const PROJECT = {
  id: 'github:thanatos27/physical-ai-robot',
  type: 'project' as const,
  title: 'physical-ai-robot',
  source: 'github' as const,
  external_ref: 'https://github.com/thanatos27/physical-ai-robot',
};

let connector: FakeProjectConnector;
let client: Client;

beforeEach(async () => {
  connector = new FakeProjectConnector();
  client = await connectClient({ project: connector });
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

const withProviders = (providers: Config['sources']['project']['providers']): Config => ({
  ...repoConfig,
  sources: { ...repoConfig.sources, project: { providers } },
});

describe('project tools', () => {
  it('lists the two read-only project tools with their schemas', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const list = byName.project_list;
    expect(list?.inputSchema).toMatchObject({ additionalProperties: false });
    expect(list?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(list?.inputSchema.properties ?? {}).sort()).toEqual(['owner', 'query']);
    expect(list?.description).toContain('project_get');

    const get = byName.project_get;
    expect(get?.inputSchema).toMatchObject({ required: ['id'], additionalProperties: false });
    expect(get?.description).toContain('github:<owner>/<repository>');
    expect(get?.description).toContain('Only repositories that project_list can return');

    for (const tool of [list, get]) {
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(tool?.outputSchema).toBeDefined();
    }
  });

  it('passes the filter to the connector and returns the items', async () => {
    connector.projects = [PROJECT];
    const result = await client.callTool({ name: 'project_list', arguments: { query: 'physical', owner: 'thanatos27' } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'list', arg: { query: 'physical', owner: 'thanatos27' } }]);
    expect(result.structuredContent).toEqual({ items: [PROJECT] });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it('lists everything with an empty filter', async () => {
    const result = await client.callTool({ name: 'project_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'list', arg: {} }]);
  });

  it.each([
    ['a blank query', { query: ' ' }],
    ['pagination input', { page: 2 }],
    ['an unknown filter', { visibility: 'private' }],
  ])('rejects %s', async (_label, args) => {
    const result = await client.callTool({ name: 'project_list', arguments: args });
    expect(result.isError).toBe(true);
    expect(connector.calls).toEqual([]);
  });

  it('gets a project with its details, kept apart', async () => {
    const result = await client.callTool({ name: 'project_get', arguments: { id: PROJECT.id } });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'get', arg: PROJECT.id }]);
    expect(result.structuredContent).toMatchObject({ project: PROJECT, details: { owner: 'thanatos27', visibility: 'public' } });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it.each([
    ['google_drive only', ['google_drive'] as const],
  ])('reports a configuration error when github is not enabled (%s)', async (_label, providers) => {
    const other = await connectWith(withProviders([...providers]), { project: connector });
    try {
      for (const call of [
        { name: 'project_list', arguments: {} },
        { name: 'project_get', arguments: { id: PROJECT.id } },
      ]) {
        const result = await other.callTool(call);
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain(
          'Configuration error: the project provider "github" is not enabled in sources.project.providers',
        );
      }
      expect(connector.calls).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('runs with github among other providers', async () => {
    const other = await connectWith(withProviders(['github', 'google_drive']), { project: connector });
    try {
      expect((await other.callTool({ name: 'project_list', arguments: {} })).isError).toBeFalsy();
    } finally {
      await other.close();
    }
  });

  it('reports a configuration error when no connector is wired', async () => {
    const other = await connectWith(repoConfig, {});
    try {
      const result = await other.callTool({ name: 'project_list', arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Configuration error: the project source (GitHub) is not configured');
    } finally {
      await other.close();
    }
  });

  it.each([
    new CredentialError('GitHub credential is not configured: set GITHUB_TOKEN'),
    new NotFoundError('project github:a/b (it does not exist or the GitHub token cannot access it)'),
    new ProviderApiError('GitHub', 'rate limit exceeded'),
  ])('returns connector errors as tool errors (%s)', async (error) => {
    connector.failWith = error;
    const result = await client.callTool({ name: 'project_get', arguments: { id: 'github:a/b' } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(error.message);
  });
});
