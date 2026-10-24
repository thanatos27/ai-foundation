import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderApiError } from '../../src/errors.js';
import { FakeScheduleConnector } from '../helpers/fake-connectors.js';
import { connectClient, resultText } from '../helpers/mcp.js';

let connector: FakeScheduleConnector;
let client: Client;

beforeEach(async () => {
  connector = new FakeScheduleConnector();
  client = await connectClient({ schedule: connector });
});

afterEach(async () => {
  await client.close();
});

describe('schedule tools', () => {
  it('lists the two schedule tools with their schemas and annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.schedule_create?.inputSchema).toMatchObject({
      required: ['title', 'start'],
      additionalProperties: false,
    });
    expect(Object.keys(byName.schedule_create?.inputSchema.properties ?? {})).toEqual(['title', 'start', 'end']);
    expect(byName.schedule_create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.schedule_list?.inputSchema).toMatchObject({ required: ['start', 'end'] });
    expect(byName.schedule_list?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('offers attended_only on schedule_list as an optional boolean', async () => {
    const { tools } = await client.listTools();
    const list = tools.find((tool) => tool.name === 'schedule_list');

    expect(list?.inputSchema).toMatchObject({ required: ['start', 'end'], additionalProperties: false });
    expect(Object.keys(list?.inputSchema.properties ?? {})).toEqual(['start', 'end', 'attended_only']);
    expect(list?.inputSchema.properties?.attended_only).toMatchObject({ type: 'boolean' });
    expect(list?.description).toContain('attended_only');
    expect(list?.description).toContain('#attended');
  });

  it.each([true, false])('passes attended_only: %s through unchanged', async (attended_only) => {
    const args = { start: '2026-09-01', end: '2026-09-30', attended_only };
    const result = await client.callTool({ name: 'schedule_list', arguments: args });

    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'list', arg: args }]);
    expect(result.structuredContent).toEqual({ schedules: [] });
  });

  it('creates a schedule and passes the domain input through unchanged', async () => {
    const input = { title: 'AI Foundationを進める', start: '2026-10-17T14:00:00+09:00' };
    const result = await client.callTool({ name: 'schedule_create', arguments: input });

    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'create', arg: input }]);
    expect(result.structuredContent).toMatchObject({ schedule: { title: 'AI Foundationを進める' } });
  });

  it('lists schedules for a period', async () => {
    connector.schedules = [
      { id: 'google_calendar:a:1', type: 'schedule', title: '出張', start: '2026-10-19', end: '2026-10-21' },
    ];
    const result = await client.callTool({
      name: 'schedule_list',
      arguments: { start: '2026-10-19', end: '2026-10-25' },
    });

    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'list', arg: { start: '2026-10-19', end: '2026-10-25' } }]);
    expect(result.structuredContent).toEqual({ schedules: connector.schedules });
  });

  it.each([
    ['schedule_create', { title: 'a', start: '2026-10-19', calendar_id: 'someone@example.com' }],
    ['schedule_create', { title: 'a', start: '2026-10-19', end: '2026-10-19T15:00:00+09:00' }],
    ['schedule_create', { title: 'a', start: '2026-10-17T14:00:00' }],
    ['schedule_create', { title: 'a', start: '2026-10-19', related_task: 'todoist:1' }],
    ['schedule_list', { start: '2026-10-19' }],
    ['schedule_list', { start: '2026-10-25', end: '2026-10-19' }],
    ['schedule_list', { start: '2026-10-19', end: '2026-10-25', attended_only: 'true' }],
    ['schedule_list', { start: '2026-10-19', end: '2026-10-25', attended_only: null }],
    ['schedule_list', { start: '2026-10-19', end: '2026-10-25', attended: true }],
  ])('rejects invalid %s input without calling the connector: %j', async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Input validation error');
    expect(connector.calls).toEqual([]);
  });

  it('returns connector errors as tool errors', async () => {
    connector.failWith = new ProviderApiError('Google Calendar', 'HTTP 503');
    const result = await client.callTool({
      name: 'schedule_list',
      arguments: { start: '2026-10-19', end: '2026-10-25' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Google Calendar API error: HTTP 503');
  });
});

describe('schedule tools without a connector', () => {
  it('return a configuration error', async () => {
    const bare = await connectClient({});
    try {
      const result = await bare.callTool({ name: 'schedule_create', arguments: { title: 'a', start: '2026-10-19' } });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe('Configuration error: the schedule source (Google Calendar) is not configured');
    } finally {
      await bare.close();
    }
  });
});
