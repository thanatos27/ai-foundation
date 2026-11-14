import { TodoistRequestError } from '@doist/todoist-sdk';
import { APIErrorCode } from '@notionhq/client';
import { describe, expect, it } from 'vitest';
import { toFoundationError as googleError } from '../../src/connectors/google-calendar/client.js';
import { createConnectors } from '../../src/connectors/index.js';
import { NotionCollectionConnector } from '../../src/connectors/notion/connector.js';
import { TodoistTaskConnector } from '../../src/connectors/todoist/connector.js';
import { EnvCredentialProvider } from '../../src/credentials/env.js';
import {
  ConfigurationError,
  ConflictError,
  CredentialError,
  type FoundationErrorCode,
  InputValidationError,
  MissingCredentialError,
  NotFoundError,
  ProviderApiError,
  providerText,
} from '../../src/errors.js';
import { HTTP_ERROR_CODES, toHttpError } from '../../src/http/errors.js';
import { apiError, DATA_SOURCE_ID, FakeNotion } from '../connectors/notion/fake-client.js';
import { FakeTodoistApi, todoistTask } from '../connectors/todoist/fake-api.js';
import { FakeKnowledgeConnector, FakeScheduleConnector, FakeTaskConnector } from '../helpers/fake-connectors.js';
import { call, createTestApp, expectConformsToDocument, withId } from '../helpers/http.js';
import { repoConfig } from '../helpers/mcp.js';

/** AC-06: every failure becomes its status and code, without secrets, causes or stack traces. */

const SECRET = 'SECRET-token-ghp_abcdefghijklmnop';

function expectNoLeak(text: string): void {
  for (const leak of [SECRET, 'stack', '    at ', 'Error:', 'cause', 'ProviderApiError', 'TodoistRequestError']) {
    expect(text).not.toContain(leak);
  }
}

describe('Foundation errors from a connector', () => {
  it.each([
    [new InputValidationError('bad id'), 400, 'invalid_input', 'Invalid input: bad id'],
    [new NotFoundError('task todoist:1'), 404, 'not_found', 'Not found: task todoist:1'],
    [new ConflictError('knowledge "obsidian:a.md" already exists'), 409, 'conflict', 'Invalid input: knowledge "obsidian:a.md" already exists'],
    [new CredentialError('Todoist rejected the API token (HTTP 401)'), 502, 'provider_auth_failed', 'Credential error: Todoist rejected the API token (HTTP 401)'],
    [new ProviderApiError('Todoist', 'HTTP 503'), 502, 'provider_error', 'Todoist API error: HTTP 503'],
    [new MissingCredentialError('set TODOIST_API_TOKEN'), 503, 'credential_missing', 'Credential error: set TODOIST_API_TOKEN'],
    [new ConfigurationError('sources.area is not configured'), 503, 'configuration_error', 'Configuration error: sources.area is not configured'],
  ] as const)('%s → %i %s', async (error, status, code, message) => {
    // Through an operation whose document declares that status (a create declares 409, an update 404).
    const task = new FakeTaskConnector();
    const knowledge = new FakeKnowledgeConnector();
    task.failWith = error;
    knowledge.failWith = error;
    const errors: unknown[] = [];
    const app = createTestApp({ task, knowledge }, { errors });
    const [method, path, template, options] =
      status === 409
        ? (['POST', '/v1/knowledge', '/v1/knowledge', { body: { title: 'a', content: 'b' } }] as const)
        : (['PATCH', withId('/v1/tasks', 'todoist:1'), '/v1/tasks/{id}', { body: { title: 'a' } }] as const);
    const result = await call(app, method, path, options);
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ error: { code, message } });
    await expectConformsToDocument(app, method, template, result);
    // 5xx are reported on the server side, as one line; the others are not.
    expect(errors).toHaveLength(status >= 500 ? 1 : 0);
  });

  it('tells a credential the provider rejected (502) from one that is not set (503)', async () => {
    const rejected = await call(createTestApp({ task: Object.assign(new FakeTaskConnector(), { failWith: new CredentialError('rejected') }) }), 'GET', '/v1/tasks');
    const missing = await call(createTestApp({ task: Object.assign(new FakeTaskConnector(), { failWith: new MissingCredentialError('set X') }) }), 'GET', '/v1/tasks');
    expect([rejected.status, rejected.body.error.code]).toEqual([502, 'provider_auth_failed']);
    expect([missing.status, missing.body.error.code]).toEqual([503, 'credential_missing']);
  });

  it('leaves provider text and causes out of the response', async () => {
    const task = new FakeTaskConnector();
    task.failWith = new ProviderApiError('Todoist', ['HTTP 500: ', providerText(SECRET), '; task todoist:1 may exist'], {
      cause: new Error(SECRET),
    });
    const result = await call(createTestApp({ task }, { errors: [] }), 'GET', '/v1/tasks');
    expect(result.body.error.message).toBe('Todoist API error: HTTP 500: (provider details omitted); task todoist:1 may exist');
    expectNoLeak(result.text);
  });

  it('maps every Foundation error code', () => {
    const codes: FoundationErrorCode[] = ['invalid_input', 'credential', 'credential_missing', 'not_found', 'conflict', 'provider_api', 'configuration'];
    for (const code of codes) {
      const error = Object.assign(new InputValidationError('x'), { code });
      expect(HTTP_ERROR_CODES).toContain(toHttpError(error).code);
      expect(toHttpError(error).status).not.toBe(500);
    }
  });
});

describe('unexpected errors', () => {
  it('answer 500 with a fixed message and report the error on the server side', async () => {
    const task = new FakeTaskConnector();
    const failure = new TypeError(`Cannot read properties of undefined (${SECRET})`, { cause: new Error(SECRET) });
    task.failWith = failure;
    const errors: unknown[] = [];
    const app = createTestApp({ task }, { errors });
    const result = await call(app, 'GET', '/v1/tasks');
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expectNoLeak(result.text);
    expect(errors).toEqual([failure]);
    await expectConformsToDocument(app, 'GET', '/v1/tasks', result);
  });

  it('answer 500 for a thrown non-error value too', async () => {
    const task = new FakeTaskConnector();
    task.list = async () => {
      throw SECRET;
    };
    const result = await call(createTestApp({ task }, { errors: [] }), 'GET', '/v1/tasks');
    expect(result.status).toBe(500);
    expectNoLeak(result.text);
  });
});

describe('requests the API refuses itself', () => {
  const app = () => createTestApp({ task: new FakeTaskConnector(), schedule: new FakeScheduleConnector() });

  it.each([
    ['malformed JSON', { body: '{"title":' }, 'Invalid input: the request body is not valid JSON'],
    ['a text body', { body: 'title=a', headers: { 'Content-Type': 'text/plain' } }, 'Invalid input: the request body must be JSON (Content-Type: application/json)'],
    ['no body', {}, undefined],
    ['a JSON array', { body: '[]' }, undefined],
  ])('answers %s with 400 invalid_input', async (_label, options, message) => {
    const result = await call(app(), 'POST', '/v1/tasks', options);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('invalid_input');
    if (message) expect(result.body.error.message).toBe(message);
  });

  it('names the failing fields of a schema check, without echoing values', async () => {
    const result = await call(app(), 'POST', '/v1/tasks', { body: { title: '', due: SECRET, extra: 1 } });
    expect(result.status).toBe(400);
    expect(result.body.error.message).toMatch(/^Invalid input: /);
    expect(result.body.error.message).toContain('title');
    expect(result.body.error.message).toContain('due');
    expect(result.body.error.message).toContain('"extra"');
    expect(result.text).not.toContain(SECRET);
  });

  it('answers a body over 1 MiB with 413 before parsing it', async () => {
    const task = new FakeTaskConnector();
    const result = await call(createTestApp({ task }), 'POST', '/v1/tasks', { body: { title: 'x'.repeat(1024 * 1024) } });
    expect(result.status).toBe(413);
    expect(result.body.error.code).toBe('payload_too_large');
    expect(task.calls).toEqual([]);
  });

  it('accepts a body just under the limit', async () => {
    const task = new FakeTaskConnector();
    const result = await call(createTestApp({ task }), 'POST', '/v1/tasks', { body: { title: 'x'.repeat(1000 * 1000) } });
    expect(result.status).toBe(201);
  });

  it.each([
    ['an unknown path', 'GET', '/v1/unknown'],
    ['an unknown method', 'DELETE', '/v1/tasks'],
    ['the root', 'GET', '/'],
    ['a path without /v1', 'GET', '/tasks'],
  ])('answers %s with 404 route_not_found', async (_label, method, path) => {
    const result = await call(app(), method, path);
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('route_not_found');
  });

  it('answers an operation whose connector is missing with 503', async () => {
    const result = await call(createTestApp({}), 'GET', '/v1/areas');
    expect(result.status).toBe(503);
    expect(result.body.error).toEqual({ code: 'configuration_error', message: expect.stringContaining('Configuration error') });
  });
});

describe('real connectors', () => {
  it('report a missing credential as 503 before any network access', async () => {
    const config = structuredClone(repoConfig);
    const app = createTestApp(createConnectors(config, new EnvCredentialProvider({})), { config, errors: [] });
    for (const [path, variable] of [
      ['/v1/tasks', 'TODOIST_API_TOKEN'],
      ['/v1/projects', 'GITHUB_TOKEN'],
    ] as const) {
      const result = await call(app, 'GET', path);
      expect(result.status).toBe(503);
      expect(result.body.error.code).toBe('credential_missing');
      expect(result.body.error.message).toContain(variable);
    }
  });

  it('keep SDK text out of a Todoist failure while keeping what to do', async () => {
    const api = new FakeTodoistApi([]);
    api.failures.deleteTask = new TodoistRequestError(SECRET, 503);
    api.failures.getTask = new TodoistRequestError(SECRET);
    const app = createTestApp({ task: new TodoistTaskConnector({ client: async () => api, timeZone: 'Asia/Tokyo' }) }, { errors: [] });
    const result = await call(app, 'POST', '/v1/tasks', { body: { title: 'a', recurrence: 'tomorrow' } });
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('provider_error');
    expect(result.body.error.message).toContain('task todoist:100 was created, but deleting it failed');
    expect(result.body.error.message).toContain('may still exist');
    expect(result.body.error.message).toContain('do not call task_create again');
    expectNoLeak(result.text);
  });

  it('keep SDK text out of a Todoist failure after closing a task', async () => {
    const api = new FakeTodoistApi([todoistTask({ id: 't1' })]);
    const close = api.closeTask.bind(api);
    api.closeTask = async (...args) => {
      const done = await close(...args);
      api.failures.getTask = new TodoistRequestError(SECRET, 500);
      return done;
    };
    const app = createTestApp({ task: new TodoistTaskConnector({ client: async () => api, timeZone: 'Asia/Tokyo' }) }, { errors: [] });
    const result = await call(app, 'POST', withId('/v1/tasks', 'todoist:t1', '/complete'));
    expect(result.status).toBe(502);
    expect(result.body.error.message).toContain('task todoist:t1 was closed');
    expectNoLeak(result.text);
  });

  it('keep SDK text out of a rejected Todoist token', async () => {
    const api = new FakeTodoistApi([]);
    api.failures.getUser = new TodoistRequestError(SECRET, 401);
    const app = createTestApp({ task: new TodoistTaskConnector({ client: async () => api, timeZone: 'Asia/Tokyo' }) }, { errors: [] });
    const result = await call(app, 'GET', '/v1/tasks');
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('provider_auth_failed');
    expectNoLeak(result.text);
  });

  it('keep SDK text out of a Notion failure after a partial update', async () => {
    const fake = new FakeNotion();
    const connector = new NotionCollectionConnector({ client: async () => fake.client, dataSourceId: DATA_SOURCE_ID, warn: () => undefined });
    const { id } = await connector.create({ title: 'a', collection_type: 'game', status: 'playing' });
    fake.failNext('blocks.children.append', apiError(503, APIErrorCode.ServiceUnavailable, SECRET));
    const config = structuredClone(repoConfig);
    const app = createTestApp({ collection: connector }, { config, errors: [] });
    const result = await call(app, 'PATCH', withId('/v1/collection-items', id!), { body: { status: 'done', append_note: 'メモ' } });
    expect(result.status).toBe(502);
    expect(result.body.error.message).toContain('were updated, but the note could not be appended');
    expect(result.body.error.message).toContain('service_unavailable');
    expectNoLeak(result.text);
  });

  it('keep SDK text out of a Google Calendar failure', async () => {
    const schedule = new FakeScheduleConnector();
    schedule.failWith = googleError({ status: 401, message: SECRET });
    const result = await call(createTestApp({ schedule }, { errors: [] }), 'GET', '/v1/schedules', {
      query: { start: '2026-11-01', end: '2026-11-02' },
    });
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('provider_auth_failed');
    expectNoLeak(result.text);
  });
});
