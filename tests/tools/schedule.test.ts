import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderApiError } from '../../src/errors.js';
import { FakeScheduleConnector } from '../helpers/fake-connectors.js';
import { connectClient, repoConfig, resultText } from '../helpers/mcp.js';

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
  it('lists the three schedule tools with their schemas and annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(byName.schedule_create?.inputSchema).toMatchObject({
      required: ['title', 'start'],
      additionalProperties: false,
    });
    expect(Object.keys(byName.schedule_create?.inputSchema.properties ?? {})).toEqual([
      'title',
      'start',
      'end',
      'calendar',
      'description',
      'location',
    ]);
    expect(byName.schedule_create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.schedule_list?.inputSchema).toMatchObject({ required: ['start', 'end'], additionalProperties: false });
    expect(Object.keys(byName.schedule_list?.inputSchema.properties ?? {})).toEqual(['start', 'end', 'calendar']);
    expect(byName.schedule_list?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.schedule_update?.inputSchema).toMatchObject({ required: ['id'], additionalProperties: false });
    expect(Object.keys(byName.schedule_update?.inputSchema.properties ?? {})).toEqual([
      'id',
      'title',
      'start',
      'end',
      'description',
      'location',
    ]);
    expect(byName.schedule_update?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it('no longer mentions the attendance flag', async () => {
    const { tools } = await client.listTools();
    const list = tools.find((tool) => tool.name === 'schedule_list');
    expect(list?.description).not.toContain('attended');
  });

  it('says when no writable calendar is configured', async () => {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'schedule_create')?.description).toContain(
      'No writable calendar is configured.',
    );
  });

  it('names the configured calendars and the default', async () => {
    const schedule = {
      ...repoConfig.sources.schedule,
      default_calendar: 'personal',
      writable_calendars: { personal: 'a@group.calendar.google.com', events: 'b@group.calendar.google.com' },
    };
    const configured = await connectClient(
      { schedule: connector },
      { ...repoConfig, sources: { ...repoConfig.sources, schedule } },
    );
    try {
      const { tools } = await configured.listTools();
      for (const name of ['schedule_create', 'schedule_list', 'schedule_update']) {
        const description = tools.find((tool) => tool.name === name)?.description;
        expect(description).toContain('Writable calendars: personal, events (default: personal).');
        expect(description).not.toContain('@group.calendar.google.com');
      }
    } finally {
      await configured.close();
    }
  });

  it('passes calendar, description and location of a new schedule through unchanged', async () => {
    const input = {
      title: '展覧会',
      start: '2026-11-01',
      end: '2026-11-03',
      calendar: 'events',
      description: '公式: https://example.com\n<b>前売り</b>',
      location: '美術館',
    };
    const result = await client.callTool({ name: 'schedule_create', arguments: input });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'create', arg: input }]);
  });

  it('passes the calendar filter through unchanged', async () => {
    const args = { start: '2026-11-01', end: '2026-11-30', calendar: 'events' };
    const result = await client.callTool({ name: 'schedule_list', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'list', arg: args }]);
  });

  it('updates a schedule, passing null to clear', async () => {
    const args = { id: 'google_calendar:a:1', description: null, location: '会場' };
    const result = await client.callTool({ name: 'schedule_update', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(connector.calls).toEqual([{ method: 'update', arg: args }]);
    expect(result.structuredContent).toMatchObject({ schedule: { id: 'google_calendar:a:1', description: null } });
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
      {
        id: 'google_calendar:a:1',
        type: 'schedule',
        calendar: 'a',
        title: '出張',
        start: '2026-10-19',
        end: '2026-10-21',
        description: '<b>メモ</b>',
        location: null,
      },
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
    ['schedule_create', { title: 'a', start: '2026-10-19', description: '' }],
    ['schedule_list', { start: '2026-10-19', end: '2026-10-25', attended_only: true }],
    ['schedule_list', { start: '2026-10-19', end: '2026-10-25', attended_only: false }],
    ['schedule_list', { start: '2026-10-19', end: '2026-10-25', calendar: '' }],
    ['schedule_update', { id: 'google_calendar:a:1' }],
    ['schedule_update', { id: 'google_calendar:a:1', end: null }],
    ['schedule_update', { id: 'google_calendar:a:1', title: null }],
    ['schedule_update', { id: 'google_calendar:a:1', calendar: 'events' }],
    ['schedule_update', { id: 'google_calendar:a:1', start: '2026-10-19', end: '2026-10-19T10:00:00+09:00' }],
    ['schedule_update', { title: 'a' }],
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
      for (const [name, args] of [
        ['schedule_create', { title: 'a', start: '2026-10-19' }],
        ['schedule_list', { start: '2026-10-19', end: '2026-10-19' }],
        ['schedule_update', { id: 'google_calendar:a:1', title: 'a' }],
      ] as const) {
        const result = await bare.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toBe('Configuration error: the schedule source (Google Calendar) is not configured');
      }
    } finally {
      await bare.close();
    }
  });
});
