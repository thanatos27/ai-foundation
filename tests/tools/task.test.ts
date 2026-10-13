import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../src/errors.js';
import { FakeTaskConnector } from '../helpers/fake-connectors.js';
import { connectClient, resultText } from '../helpers/mcp.js';

let connector: FakeTaskConnector;
let client: Client;

beforeEach(async () => {
  connector = new FakeTaskConnector();
  client = await connectClient({ task: connector });
});

afterEach(async () => {
  await client.close();
});

describe('task tools', () => {
  it('lists the four task tools with their schemas and annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.task_create?.inputSchema).toMatchObject({ required: ['title'], additionalProperties: false });
    expect(byName.task_create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.task_create?.description).toContain('Asia/Tokyo');

    const status = (byName.task_list?.inputSchema.properties as Record<string, { items?: { enum?: string[] } }>)
      .status;
    expect(status?.items?.enum).toEqual(['inbox', 'next', 'waiting', 'someday']);
    expect(byName.task_list?.annotations).toMatchObject({ readOnlyHint: true });

    expect(byName.task_update?.inputSchema).toMatchObject({ required: ['id'] });
    expect(byName.task_update?.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.task_complete?.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.task_complete?.outputSchema).toBeDefined();
  });

  it('creates a task and returns it as structured content and JSON text', async () => {
    const input = { title: '経費精算', status: 'next', due: '2026-10-16', area: 'work', tags: ['accounting'] };
    const result = await client.callTool({ name: 'task_create', arguments: input });

    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'create', arg: input }]);
    expect(result.structuredContent).toMatchObject({ task: { id: 'todoist:1', title: '経費精算', status: 'next' } });
    expect(JSON.parse(resultText(result))).toEqual(result.structuredContent);
  });

  it('passes list filters through unchanged', async () => {
    await connector.create({ title: 'a' });
    const filter = { status: ['next', 'waiting'], area: 'work', due_before: '2026-10-31', tags: ['x'] };
    const result = await client.callTool({ name: 'task_list', arguments: filter });

    expect(result.isError).toBeFalsy();
    expect(connector.calls.at(-1)).toEqual({ method: 'list', arg: filter });
    expect(result.structuredContent).toMatchObject({ tasks: [{ id: 'todoist:1' }] });
  });

  it('lists with an empty filter', async () => {
    const result = await client.callTool({ name: 'task_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ tasks: [] });
  });

  it('updates and completes by id', async () => {
    const updated = await client.callTool({
      name: 'task_update',
      arguments: { id: 'todoist:9', status: 'waiting', due: null },
    });
    expect(updated.isError).toBeFalsy();
    expect(connector.calls.at(-1)).toEqual({ method: 'update', arg: { id: 'todoist:9', status: 'waiting', due: null } });

    const completed = await client.callTool({ name: 'task_complete', arguments: { id: 'todoist:9' } });
    expect(completed.isError).toBeFalsy();
    expect(connector.calls.at(-1)).toEqual({ method: 'complete', arg: 'todoist:9' });
    expect(completed.structuredContent).toMatchObject({ task: { status: 'done' } });
  });

  it.each([
    ['task_create', { title: 'a', status: 'done' }],
    ['task_create', { title: 'a', project_ref: 'github:x/y' }],
    ['task_create', { title: 'a', tags: ['af-next'] }],
    ['task_list', { status: ['done'] }],
    ['task_update', { id: 'todoist:1' }],
    ['task_update', { id: 'todoist:1', status: 'done' }],
    ['task_complete', {}],
  ])('rejects invalid %s input without calling the connector: %j', async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Input validation error');
    expect(connector.calls).toEqual([]);
  });

  it('returns connector errors as tool errors', async () => {
    connector.failWith = new NotFoundError('task todoist:404');
    const result = await client.callTool({ name: 'task_complete', arguments: { id: 'todoist:404' } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Not found: task todoist:404');
  });
});

describe('task tools without a connector', () => {
  it('are still listed and return a configuration error', async () => {
    const bare = await connectClient({});
    try {
      const { tools } = await bare.listTools();
      expect(tools.map((tool) => tool.name)).toContain('task_create');

      const result = await bare.callTool({ name: 'task_list', arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe('Configuration error: the task source (Todoist) is not configured');
    } finally {
      await bare.close();
    }
  });
});
