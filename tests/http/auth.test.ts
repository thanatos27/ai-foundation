import { describe, expect, it } from 'vitest';
import type { Connectors } from '../../src/connectors/types.js';
import { ApiKeyError, MIN_API_KEY_LENGTH, parseApiKey } from '../../src/http/auth.js';
import {
  FakeAreaConnector,
  FakeCollectionConnector,
  FakeKnowledgeConnector,
  FakeLifeLogConnector,
  FakeProjectConnector,
  FakeScheduleConnector,
  FakeTaskConnector,
} from '../helpers/fake-connectors.js';
import { call, createTestApp, expectConformsToDocument, TEST_API_KEY, withId } from '../helpers/http.js';

/** AC-02: one shared API key; without it nothing reaches a connector, /openapi.json included. */

function fakes() {
  const connectors = {
    task: new FakeTaskConnector(),
    schedule: new FakeScheduleConnector(),
    collection: new FakeCollectionConnector(),
    knowledge: new FakeKnowledgeConnector(),
    project: new FakeProjectConnector(),
    area: new FakeAreaConnector(),
    lifelog: new FakeLifeLogConnector(),
  } satisfies Connectors;
  const calls = () => Object.values(connectors).flatMap((connector): { method: string; arg: unknown }[] => connector.calls);
  return { connectors, calls };
}

const K = 'obsidian:AI Foundation/Knowledge/a.md';
/** One request per operation, each valid apart from the key. */
const REQUESTS: [string, string, Parameters<typeof call>[3]][] = [
  ['GET', '/v1/tasks', {}],
  ['POST', '/v1/tasks', { body: { title: 'a' } }],
  ['PATCH', withId('/v1/tasks', 'todoist:1'), { body: { title: 'a' } }],
  ['POST', withId('/v1/tasks', 'todoist:1', '/complete'), {}],
  ['GET', '/v1/schedules', { query: { start: '2026-11-01', end: '2026-11-02' } }],
  ['POST', '/v1/schedules', { body: { title: 'a', start: '2026-11-01' } }],
  ['PATCH', withId('/v1/schedules', 'google_calendar:c:e'), { body: { title: 'a' } }],
  ['GET', '/v1/collection-items', {}],
  ['POST', '/v1/collection-items', { body: { title: 'a', collection_type: 'game', status: 'x' } }],
  ['PATCH', withId('/v1/collection-items', 'notion:1'), { body: { status: 'x' } }],
  ['GET', '/v1/knowledge', {}],
  ['POST', '/v1/knowledge', { body: { title: 'a', content: 'b' } }],
  ['GET', '/v1/knowledge/entry', { query: { id: K } }],
  ['POST', '/v1/knowledge/entry/append', { query: { id: K }, body: { content: 'b' } }],
  ['GET', '/v1/projects', {}],
  ['GET', '/v1/projects/entry', { query: { id: 'github:o/r' } }],
  ['GET', '/v1/areas', {}],
  ['GET', withId('/v1/areas', 'notion:1'), {}],
  ['POST', '/v1/lifelogs', { body: { date: '2026-10-03', title: 'a', content: 'b' } }],
  ['GET', withId('/v1/lifelogs', 'lifelog:2026-10-03-a.md'), {}],
  ['POST', withId('/v1/lifelogs', 'lifelog:2026-10-03-a.md', '/append'), { body: { content: 'b' } }],
];

const BAD_HEADERS: [string, Record<string, string>][] = [
  ['no Authorization header', {}],
  ['the Basic scheme', { Authorization: `Basic ${TEST_API_KEY}` }],
  ['an empty token', { Authorization: 'Bearer ' }],
  ['the scheme only', { Authorization: 'Bearer' }],
  ['another key', { Authorization: `Bearer ${'x'.repeat(TEST_API_KEY.length)}` }],
  ['a shorter key', { Authorization: `Bearer ${TEST_API_KEY.slice(0, -1)}` }],
  ['a longer key', { Authorization: `Bearer ${TEST_API_KEY}x` }],
  ['the key with extra text', { Authorization: `Bearer ${TEST_API_KEY} extra` }],
  ['the key without the scheme', { Authorization: TEST_API_KEY }],
];

describe('API key', () => {
  it.each(BAD_HEADERS)('refuses %s on every operation without calling a connector', async (_label, headers) => {
    const { connectors, calls } = fakes();
    const app = createTestApp(connectors);
    for (const [method, path, options] of REQUESTS) {
      const result = await call(app, method, path, { ...options, key: null, headers });
      expect(result.status, `${method} ${path}`).toBe(401);
      expect(result.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
      expect(result.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(calls()).toEqual([]);
  });

  it('declares the 401 response it returns', async () => {
    const app = createTestApp(fakes().connectors);
    const result = await call(app, 'GET', '/v1/tasks', { key: null });
    await expectConformsToDocument(app, 'GET', '/v1/tasks', result);
  });

  it('never echoes the key that was sent', async () => {
    const app = createTestApp(fakes().connectors);
    const result = await call(app, 'GET', '/v1/tasks', { key: 'wrong-key-wrong-key-wrong-key-wrong-key' });
    expect(result.text).not.toContain('wrong-key');
    expect(result.text).not.toContain(TEST_API_KEY);
  });

  it('accepts the scheme in any case', async () => {
    const { connectors, calls } = fakes();
    const app = createTestApp(connectors);
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const result = await call(app, 'GET', '/v1/tasks', { key: null, headers: { Authorization: `${scheme} ${TEST_API_KEY}` } });
      expect(result.status).toBe(200);
    }
    expect(calls()).toHaveLength(3);
  });

  it('protects /openapi.json the same way', async () => {
    const app = createTestApp(fakes().connectors);
    expect((await call(app, 'GET', '/openapi.json', { key: null })).status).toBe(401);
    expect((await call(app, 'GET', '/openapi.json', { key: 'x'.repeat(40) })).status).toBe(401);
    const result = await call(app, 'GET', '/openapi.json');
    expect(result.status).toBe(200);
    expect(result.body.openapi).toBe('3.1.0');
  });

  it('answers an unknown path with 401 before telling that it does not exist', async () => {
    const app = createTestApp(fakes().connectors);
    expect((await call(app, 'GET', '/v1/secret-admin', { key: null })).status).toBe(401);
    expect((await call(app, 'GET', '/v1/secret-admin')).status).toBe(404);
  });

  it('checks the key before reading a body, however large or malformed', async () => {
    const { connectors, calls } = fakes();
    const app = createTestApp(connectors);
    for (const body of ['{', 'x'.repeat(2 * 1024 * 1024)]) {
      expect((await call(app, 'POST', '/v1/tasks', { key: null, body })).status).toBe(401);
    }
    expect(calls()).toEqual([]);
  });
});

describe('parseApiKey', () => {
  const key = 'k'.repeat(MIN_API_KEY_LENGTH);

  it('accepts 32 or more printable ASCII characters, ignoring surrounding whitespace', () => {
    expect(parseApiKey(key)).toBe(key);
    expect(parseApiKey(` ${key}\n`)).toBe(key);
    expect(parseApiKey('A-Za-z0-9._~+/=!#$%&*?@^|'.padEnd(40, 'x'))).toHaveLength(40);
  });

  it.each([
    ['unset', undefined, /AI_FOUNDATION_API_KEY is not set/],
    ['empty', '', /is not set/],
    ['blank', '   ', /is not set/],
    ['31 characters', 'k'.repeat(MIN_API_KEY_LENGTH - 1), /at least 32 characters/],
    ['a space inside', `${key} ${key}`, /printable ASCII/],
    ['non-ASCII', `${key}鍵`, /printable ASCII/],
    ['a control character', `${key}\u0007`, /printable ASCII/],
  ])('refuses a key that is %s, without showing it', (_label, value, message) => {
    let error: unknown;
    try {
      parseApiKey(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiKeyError);
    expect((error as Error).message).toMatch(message);
    if (value?.trim()) expect((error as Error).message).not.toContain(value.trim());
  });
});
