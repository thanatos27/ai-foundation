import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarApi, GoogleEvent } from '../../src/connectors/google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from '../../src/connectors/google-calendar/connector.js';
import { createConnectors } from '../../src/connectors/index.js';
import { EnvCredentialProvider } from '../../src/credentials/env.js';
import { ConflictError } from '../../src/errors.js';
import {
  FakeCollectionConnector,
  FakeKnowledgeConnector,
  FakeLifeLogConnector,
  FakeScheduleConnector,
  FakeTaskConnector,
} from '../helpers/fake-connectors.js';
import { call, createTestApp, expectConformsToDocument, withId } from '../helpers/http.js';
import { repoConfig } from '../helpers/mcp.js';
import { createTestVault, KNOWLEDGE_DIR, LIFELOG_DIR, type TestVault } from '../helpers/vault.js';

/**
 * AC-04: the HTTP API keeps each operation's rules. The fakes show what reaches the connector (and
 * that a refused request reaches nothing); the real connectors show the rules they enforce.
 */

describe('Task', () => {
  let task: FakeTaskConnector;
  let app: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    task = new FakeTaskConnector();
    app = createTestApp({ task });
  });
  const patch = (body: unknown) => call(app, 'PATCH', withId('/v1/tasks', 'todoist:t1'), { body });

  it('passes only the given fields: omitted ones are not sent at all', async () => {
    expect((await patch({ title: 'new' })).status).toBe(200);
    expect(task.calls[0]!.arg).toStrictEqual({ id: 'todoist:t1', title: 'new' });
  });

  it('passes null to clear the due and the area', async () => {
    expect((await patch({ due: null, area: null })).status).toBe(200);
    expect(task.calls[0]!.arg).toStrictEqual({ id: 'todoist:t1', due: null, area: null });
  });

  it('passes tags as the replacement set, [] included', async () => {
    await patch({ tags: ['a', 'b'] });
    await patch({ tags: [] });
    expect(task.calls.map((c) => c.arg)).toStrictEqual([
      { id: 'todoist:t1', tags: ['a', 'b'] },
      { id: 'todoist:t1', tags: [] },
    ]);
  });

  it('passes recurrence: null to remove the rule', async () => {
    expect((await patch({ recurrence: null })).status).toBe(200);
    expect(task.calls[0]!.arg).toStrictEqual({ id: 'todoist:t1', recurrence: null });
  });

  it.each([
    ['an empty body', 'PATCH', {}, /At least one of/],
    ['recurrence with another field', 'PATCH', { recurrence: 'every monday', title: 'x' }, /recurrence must be updated on its own/],
    ['status done', 'PATCH', { status: 'done' }, /status/],
    ['a reserved tag', 'PATCH', { tags: ['af-next'] }, /reserved for AI Foundation/],
    ['id in the body', 'PATCH', { id: 'todoist:other', title: 'x' }, /Unrecognized key/],
    ['null for a field that cannot be cleared', 'PATCH', { title: null }, /title/],
    ['due with recurrence', 'POST', { title: 'a', due: '2026-11-20', recurrence: 'every day' }, /due and recurrence cannot be specified together/],
    ['status done on create', 'POST', { title: 'a', status: 'done' }, /status/],
    ['a date-time without an offset', 'POST', { title: 'a', due: '2026-11-20T09:00:00' }, /due/],
  ])('refuses %s with 400 before calling the connector', async (_label, method, body, message) => {
    const result =
      method === 'PATCH' ? await patch(body) : await call(app, 'POST', '/v1/tasks', { body });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('invalid_input');
    expect(result.body.error.message).toMatch(message);
    expect(task.calls).toEqual([]);
  });

  it('returns the next, still open occurrence when completing a recurring task', async () => {
    task.complete = async (id) => {
      task.calls.push({ method: 'complete', arg: id });
      return { id, type: 'task', title: 'ゴミ出し', status: 'inbox', due: '2026-11-21', recurrence: 'every friday' };
    };
    const result = await call(app, 'POST', withId('/v1/tasks', 'todoist:r1', '/complete'));
    expect(result.status).toBe(200);
    expect(result.body.task).toMatchObject({ status: 'inbox', due: '2026-11-21', recurrence: 'every friday' });
    await expectConformsToDocument(app, 'POST', '/v1/tasks/{id}/complete', result);
  });

  it('ignores a body on task_complete and completes the task in the path', async () => {
    const result = await call(app, 'POST', withId('/v1/tasks', 'todoist:r1', '/complete'), { body: { id: 'x' } });
    // No body is declared: whatever is sent is ignored and the path id is used.
    expect(result.status).toBe(200);
    expect(task.calls).toEqual([{ method: 'complete', arg: 'todoist:r1' }]);
  });
});

describe('Schedule (the rules differ per operation)', () => {
  let schedule: FakeScheduleConnector;
  let app: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    schedule = new FakeScheduleConnector();
    app = createTestApp({ schedule });
  });
  const list = (query: Record<string, string>) => call(app, 'GET', '/v1/schedules', { query });
  const create = (body: unknown) => call(app, 'POST', '/v1/schedules', { body });
  const update = (body: unknown) => call(app, 'PATCH', withId('/v1/schedules', 'google_calendar:c:e'), { body });

  describe('schedule_list', () => {
    it.each([
      ['dates', { start: '2026-11-01', end: '2026-11-30' }],
      ['date-times', { start: '2026-11-01T09:00:00+09:00', end: '2026-11-01T18:00:00+09:00' }],
      ['a date and a date-time', { start: '2026-11-01', end: '2026-11-01T18:00:00+09:00' }],
      ['a date-time and a date', { start: '2026-11-01T09:00:00+09:00', end: '2026-11-02' }],
    ])('passes %s through to the connector as given', async (_label, query) => {
      expect((await list(query)).status).toBe(200);
      expect(schedule.calls[0]!.arg).toStrictEqual(query);
    });

    it.each([
      ['no end', { start: '2026-11-01' }],
      ['no start', { end: '2026-11-01' }],
      ['dates in reverse', { start: '2026-11-02', end: '2026-11-01' }],
      ['date-times in reverse', { start: '2026-11-01T10:00:00+09:00', end: '2026-11-01T09:00:00+09:00' }],
    ])('refuses %s with 400 before calling the connector', async (_label, query) => {
      expect((await list(query)).status).toBe(400);
      expect(schedule.calls).toEqual([]);
    });
  });

  describe('schedule_create', () => {
    it('passes an omitted end as omitted (the connector applies the default length)', async () => {
      const result = await create({ title: '打ち合わせ', start: '2026-11-20T14:00:00+09:00' });
      expect(result.status).toBe(201);
      expect(schedule.calls[0]!.arg).toStrictEqual({ title: '打ち合わせ', start: '2026-11-20T14:00:00+09:00' });
    });

    it('passes an all-day period with its inclusive last day', async () => {
      expect((await create({ title: '展示会', start: '2026-11-21', end: '2026-11-23' })).status).toBe(201);
      expect(schedule.calls[0]!.arg).toMatchObject({ start: '2026-11-21', end: '2026-11-23' });
    });

    it.each([
      ['a date and a date-time', { title: 'a', start: '2026-11-21', end: '2026-11-21T10:00:00+09:00' }],
      ['end before start', { title: 'a', start: '2026-11-21', end: '2026-11-20' }],
      ['no start', { title: 'a' }],
    ])('refuses %s with 400 before calling the connector', async (_label, body) => {
      expect((await create(body)).status).toBe(400);
      expect(schedule.calls).toEqual([]);
    });
  });

  describe('schedule_update', () => {
    it.each([
      ['only start', { start: '2026-11-21T10:00:00+09:00' }],
      ['only end', { end: '2026-11-21T12:00:00+09:00' }],
      ['description and location cleared', { description: null, location: null }],
    ])('passes %s and nothing else', async (_label, body) => {
      expect((await update(body)).status).toBe(200);
      expect(schedule.calls[0]!.arg).toStrictEqual({ id: 'google_calendar:c:e', ...body });
    });

    it.each([
      ['an empty body', {}],
      ['both given, of different kinds', { start: '2026-11-21', end: '2026-11-21T12:00:00+09:00' }],
      ['both given, in reverse', { start: '2026-11-22', end: '2026-11-21' }],
      ['a calendar (events never move)', { calendar: 'events' }],
      ['null for the title', { title: null }],
    ])('refuses %s with 400 before calling the connector', async (_label, body) => {
      expect((await update(body)).status).toBe(400);
      expect(schedule.calls).toEqual([]);
    });
  });

  describe('with the Google Calendar connector', () => {
    const CAL = 'af@group.calendar.google.com';
    const timed: GoogleEvent = {
      id: 'e1',
      summary: '打ち合わせ',
      start: { dateTime: '2026-11-20T14:00:00+09:00' },
      end: { dateTime: '2026-11-20T15:00:00+09:00' },
    };
    function realApp() {
      const listed: { timeMin: string; timeMax: string }[] = [];
      const api: CalendarApi = {
        insertEvent: async (_c, event) => ({ ...event, id: 'new' }),
        getEvent: async () => timed,
        patchEvent: async (_c, _e, patch) => ({ ...timed, ...patch }),
        listCalendars: async () => [{ id: CAL, summary: 'AI Foundation' }],
        listEvents: async (_c, range) => {
          listed.push(range);
          return [];
        },
      };
      const connector = new GoogleCalendarScheduleConnector({
        api: async () => api,
        writableCalendars: { personal: CAL },
        defaultCalendar: 'personal',
        timeZone: 'Asia/Tokyo',
      });
      return { app: createTestApp({ schedule: connector }), listed };
    }

    it('reads a mixed period in the configured time zone', async () => {
      const { app, listed } = realApp();
      const result = await call(app, 'GET', '/v1/schedules', {
        query: { start: '2026-11-01', end: '2026-11-01T18:00:00+09:00' },
      });
      expect(result.status).toBe(200);
      // The day starts at midnight in Asia/Tokyo; the date-time is taken as given.
      expect(listed.map(({ timeMin, timeMax }) => [Date.parse(timeMin), Date.parse(timeMax)])).toEqual([
        [Date.parse('2026-11-01T00:00:00+09:00'), Date.parse('2026-11-01T18:00:00+09:00')],
      ]);
    });

    it('refuses a mixed period in reverse, as the connector checks it', async () => {
      const { app, listed } = realApp();
      const result = await call(app, 'GET', '/v1/schedules', {
        query: { start: '2026-11-02', end: '2026-11-01T18:00:00+09:00' },
      });
      expect(result.status).toBe(400);
      expect(result.body.error.message).toMatch(/is earlier than start/);
      expect(listed).toEqual([]);
    });

    it('moves only the end of an event, checked against its start', async () => {
      const { app } = realApp();
      const ok = await call(app, 'PATCH', withId('/v1/schedules', `google_calendar:${CAL}:e1`), {
        body: { end: '2026-11-20T16:00:00+09:00' },
      });
      expect(ok.status, ok.text).toBe(200);
      const before = await call(app, 'PATCH', withId('/v1/schedules', `google_calendar:${CAL}:e1`), {
        body: { end: '2026-11-20T13:00:00+09:00' },
      });
      expect(before.status).toBe(400);
      expect(before.body.error.message).toMatch(/would be earlier than the event's start/);
      const kind = await call(app, 'PATCH', withId('/v1/schedules', `google_calendar:${CAL}:e1`), {
        body: { end: '2026-11-21' },
      });
      expect(kind.status).toBe(400);
      expect(kind.body.error.message).toMatch(/give both start and end/);
    });
  });
});

describe('Collection', () => {
  let collection: FakeCollectionConnector;
  let app: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    collection = new FakeCollectionConnector();
    collection.items = [
      {
        id: 'notion:1',
        type: 'collection',
        title: 'Zelda',
        collection_type: 'game',
        status: 'playing',
        metadata: { platform: 'Switch', rating: 4 },
        tags: ['rpg', 'nintendo'],
      },
    ];
    app = createTestApp({ collection });
  });
  const patch = (body: unknown) => call(app, 'PATCH', withId('/v1/collection-items', 'notion:1'), { body });

  it('merges metadata key by key and replaces tags', async () => {
    const result = await patch({ metadata: { rating: 5, finished: null }, tags: ['rpg'] });
    expect(result.status).toBe(200);
    expect(result.body.item.metadata).toEqual({ platform: 'Switch', rating: 5, finished: null });
    expect(result.body.item.tags).toEqual(['rpg']);
    expect(collection.calls[0]!.arg).toStrictEqual({ id: 'notion:1', metadata: { rating: 5, finished: null }, tags: ['rpg'] });
  });

  it('passes [] to remove every tag and null to clear the status', async () => {
    const result = await patch({ tags: [], status: null });
    expect(result.body.item).toMatchObject({ tags: [], status: null });
  });

  it('accepts append_note alone', async () => {
    expect((await patch({ append_note: 'クリアした' })).status).toBe(200);
    expect(collection.calls[0]!.arg).toStrictEqual({ id: 'notion:1', append_note: 'クリアした' });
  });

  it.each([
    ['an empty body', {}],
    ['append_note: null alone (changes nothing)', { append_note: null }],
    ['a title (cannot be changed)', { title: 'x' }],
    ['a blank note', { append_note: '   ' }],
  ])('refuses %s with 400 before calling the connector', async (_label, body) => {
    expect((await patch(body)).status).toBe(400);
    expect(collection.calls).toEqual([]);
  });
});

describe('Knowledge and Life Log', () => {
  describe('with fakes', () => {
    it('applies the default area when none is given, and keeps null as no area', async () => {
      const knowledge = new FakeKnowledgeConnector();
      const app = createTestApp({ knowledge });
      await call(app, 'POST', '/v1/knowledge', { body: { title: 'a', content: 'b' } });
      await call(app, 'POST', '/v1/knowledge', { body: { title: 'c', content: 'd', area: null } });
      expect(knowledge.calls.map((c) => (c.arg as { area: unknown }).area)).toEqual([repoConfig.defaults.area, null]);
    });

    it('takes area=none as knowledge without an area', async () => {
      const knowledge = new FakeKnowledgeConnector();
      const app = createTestApp({ knowledge });
      expect((await call(app, 'GET', '/v1/knowledge', { query: { area: 'none' } })).status).toBe(200);
      expect((await call(app, 'GET', '/v1/knowledge', { query: { area: 'work' } })).status).toBe(200);
      expect((await call(app, 'GET', '/v1/knowledge', { query: { area: 'null' } })).status).toBe(400);
      expect(knowledge.calls.map((c) => c.arg)).toStrictEqual([{ area: null }, { area: 'work' }]);
    });

    it('answers a conflict with 409', async () => {
      const lifelog = new FakeLifeLogConnector();
      lifelog.failWith = new ConflictError('life log "lifelog:2026-10-03-a.md" already exists');
      const app = createTestApp({ lifelog });
      const result = await call(app, 'POST', '/v1/lifelogs', { body: { date: '2026-10-03', title: 'a', content: 'b' } });
      expect(result.status).toBe(409);
      expect(result.body.error).toEqual({ code: 'conflict', message: expect.stringContaining('already exists') });
      await expectConformsToDocument(app, 'POST', '/v1/lifelogs', result);
    });
  });

  describe('with the Obsidian connectors on a temporary vault', () => {
    let vault: TestVault;
    let app: ReturnType<typeof createTestApp>;
    beforeEach(async () => {
      vault = await createTestVault();
      const config = structuredClone(repoConfig);
      config.sources.knowledge.obsidian = { storage: 'filesystem', vault_path: vault.vault, knowledge_dir: KNOWLEDGE_DIR };
      config.sources.lifelog = { provider: 'obsidian', obsidian: { directory: LIFELOG_DIR } };
      app = createTestApp(createConnectors(config, new EnvCredentialProvider({})), { config });
    });
    afterEach(() => vault.cleanup());

    it('never overwrites knowledge with the same name: 409, the file unchanged', async () => {
      const first = await call(app, 'POST', '/v1/knowledge', { body: { title: 'CAP定理', content: '元の本文' } });
      expect(first.status).toBe(201);
      const before = await readFile(vault.abs(`${KNOWLEDGE_DIR}/CAP定理.md`));
      const second = await call(app, 'POST', '/v1/knowledge', { body: { title: 'CAP定理', content: '上書き?' } });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('conflict');
      expect(second.body.error.message).toContain('knowledge_append');
      expect(Buffer.compare(await readFile(vault.abs(`${KNOWLEDGE_DIR}/CAP定理.md`)), before)).toBe(0);
      for (const secret of vault.secrets) expect(second.text).not.toContain(secret);
    });

    it('appends to knowledge without touching the frontmatter or the body', async () => {
      const created = await call(app, 'POST', '/v1/knowledge', {
        body: { title: 'メモ', content: '本文', tags: ['db'], description: '要約' },
      });
      const id = created.body.knowledge.id as string;
      const before = await vault.read(`${KNOWLEDGE_DIR}/メモ.md`);
      const appended = await call(app, 'POST', '/v1/knowledge/entry/append', { query: { id }, body: { content: '追記' } });
      expect(appended.status).toBe(200);
      const after = await vault.read(`${KNOWLEDGE_DIR}/メモ.md`);
      expect(after.startsWith(before.trimEnd())).toBe(true);
      expect(after.trimEnd().endsWith('追記')).toBe(true);
      const got = await call(app, 'GET', '/v1/knowledge/entry', { query: { id } });
      expect(got.body.content).toContain('本文');
      expect(got.body.content).toContain('追記');
      expect(got.body.knowledge).toMatchObject({ title: 'メモ', description: '要約', tags: ['db'] });
      await expectConformsToDocument(app, 'GET', '/v1/knowledge/entry', got);
    });

    it('never overwrites a life log with the same date and title: 409, the file unchanged', async () => {
      const body = { date: '2026-10-03', title: '東京散策', content: '元の本文' };
      const first = await call(app, 'POST', '/v1/lifelogs', { body });
      expect(first.status).toBe(201);
      const second = await call(app, 'POST', '/v1/lifelogs', { body: { ...body, content: '別の本文' } });
      expect(second.status).toBe(409);
      expect(await vault.read(`${LIFELOG_DIR}/2026-10-03-東京散策.md`)).toBe('元の本文\n');
    });

    it('appends to a life log as a new paragraph, adding no heading or date', async () => {
      const created = await call(app, 'POST', '/v1/lifelogs', { body: { date: '2026-10-03', title: '散策', content: '午前' } });
      const id = created.body.lifelog.id as string;
      const appended = await call(app, 'POST', withId('/v1/lifelogs', id, '/append'), { body: { content: '午後' } });
      expect(appended.status).toBe(200);
      expect(await vault.read(`${LIFELOG_DIR}/2026-10-03-散策.md`)).toBe('午前\n\n午後\n');
      const got = await call(app, 'GET', withId('/v1/lifelogs', id));
      expect(got.body).toEqual({ lifelog: created.body.lifelog, content: '午前\n\n午後\n' });
    });
  });
});
