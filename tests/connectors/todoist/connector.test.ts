import { TodoistRequestError } from '@doist/todoist-sdk';
import { describe, expect, it, vi } from 'vitest';
import { lazyTodoistClient } from '../../../src/connectors/todoist/client.js';
import { TodoistTaskConnector } from '../../../src/connectors/todoist/connector.js';
import { EnvCredentialProvider } from '../../../src/credentials/env.js';
import {
  CredentialError,
  FoundationError,
  InputValidationError,
  NotFoundError,
  ProviderApiError,
} from '../../../src/errors.js';
import { FakeTodoistApi, todoistTask } from './fake-api.js';

const TZ = 'Asia/Tokyo';

function setup(tasks = [todoistTask({ id: 't1', content: '経費精算', labels: ['af-next', 'af-area-work', 'x'] })]) {
  const api = new FakeTodoistApi(tasks);
  const connector = new TodoistTaskConnector({ client: async () => api, timeZone: TZ });
  return { api, connector };
}

async function rejection(promise: Promise<unknown>): Promise<FoundationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FoundationError);
  return error as FoundationError;
}

describe('create', () => {
  it('adds the task to the Inbox with labels and a date due', async () => {
    const { api, connector } = setup([]);
    const task = await connector.create({
      title: '経費精算',
      status: 'next',
      due: '2026-10-16',
      area: 'work',
      tags: ['accounting'],
    });

    const [[args]] = api.callsOf('addTask') as [[Record<string, unknown>]];
    expect(args).toEqual({ content: '経費精算', labels: ['af-next', 'af-area-work', 'accounting'], dueDate: '2026-10-16' });
    expect(args).not.toHaveProperty('projectId');
    expect(task).toMatchObject({
      id: 'todoist:100',
      title: '経費精算',
      status: 'next',
      due: '2026-10-16',
      area: 'work',
      tags: ['accounting'],
      project_ref: null,
    });
  });

  it('sends a date-time due as UTC and defaults to inbox', async () => {
    const { api, connector } = setup([]);
    const task = await connector.create({ title: 'a', due: '2026-10-16T18:00:00+09:00' });

    expect(api.callsOf('addTask')[0]?.[0]).toEqual({ content: 'a', labels: [], dueDatetime: '2026-10-16T09:00:00Z' });
    expect(task).toMatchObject({ status: 'inbox', area: null, due: '2026-10-16T18:00:00+09:00' });
  });

  it('omits due when it is null', async () => {
    const { api, connector } = setup([]);
    await connector.create({ title: 'a', due: null });
    expect(api.callsOf('addTask')[0]?.[0]).toEqual({ content: 'a', labels: [] });
  });
});

describe('list', () => {
  const inbox = [
    todoistTask({ id: '1', content: 'next work', labels: ['af-next', 'af-area-work'], due: { isRecurring: false, string: '', date: '2026-10-16' } }),
    todoistTask({ id: '2', content: 'inbox', labels: ['accounting'] }),
    todoistTask({ id: '3', content: 'waiting', labels: ['af-waiting', 'accounting'] }),
    todoistTask({ id: '4', content: 'done', checked: true }),
    todoistTask({ id: '5', content: 'other project', projectId: 'p2' }),
  ];

  it('returns every open Inbox task across pages', async () => {
    const { api, connector } = setup(inbox);
    const tasks = await connector.list({});

    expect(tasks.map((task) => task.title)).toEqual(['next work', 'inbox', 'waiting']);
    expect(api.callsOf('getTasks').map(([args]) => args)).toEqual([
      { projectId: 'inbox-project', limit: 200, cursor: null },
      { projectId: 'inbox-project', limit: 200, cursor: '2' },
    ]);
  });

  it('resolves the Inbox once', async () => {
    const { api, connector } = setup(inbox);
    await connector.list({});
    await connector.list({});
    expect(api.callsOf('getUser')).toHaveLength(1);
  });

  it('applies the filter', async () => {
    const { connector } = setup(inbox);
    expect((await connector.list({ status: ['next', 'waiting'] })).map((t) => t.title)).toEqual(['next work', 'waiting']);
    expect((await connector.list({ area: 'work' })).map((t) => t.title)).toEqual(['next work']);
    expect((await connector.list({ tags: ['accounting'] })).map((t) => t.title)).toEqual(['inbox', 'waiting']);
    expect((await connector.list({ due_before: '2026-10-16' })).map((t) => t.title)).toEqual(['next work']);
  });

  it('retries the Inbox lookup after a failure', async () => {
    const { api, connector } = setup(inbox);
    api.failures.getUser = new TodoistRequestError('Service Unavailable', 503);
    await expect(connector.list({})).rejects.toBeInstanceOf(ProviderApiError);
    await expect(connector.list({})).resolves.toHaveLength(3);
  });
});

describe('update', () => {
  it('swaps the status label without touching area, tags or other af- labels', async () => {
    const { api, connector } = setup([todoistTask({ id: 't1', labels: ['af-next', 'af-area-work', 'x', 'af-future'] })]);
    const task = await connector.update({ id: 'todoist:t1', status: 'waiting' });

    expect(api.callsOf('updateTask')).toEqual([['t1', { labels: ['af-area-work', 'x', 'af-future', 'af-waiting'] }]]);
    expect(task).toMatchObject({ status: 'waiting', area: 'work', tags: ['x'] });
  });

  it('replaces tags while keeping AI Foundation labels', async () => {
    const { api, connector } = setup([todoistTask({ id: 't1', labels: ['af-next', 'af-area-work', 'x', 'af-future'] })]);
    const task = await connector.update({ id: 'todoist:t1', tags: ['y', 'z'] });

    expect(api.callsOf('updateTask')[0]?.[1]).toEqual({ labels: ['af-next', 'af-area-work', 'af-future', 'y', 'z'] });
    expect(task).toMatchObject({ status: 'next', area: 'work', tags: ['y', 'z'] });
  });

  it('clears the area', async () => {
    const { connector } = setup();
    expect(await connector.update({ id: 'todoist:t1', area: null })).toMatchObject({ area: null, status: 'next' });
  });

  it('sends only the changed fields', async () => {
    const { api, connector } = setup();
    await connector.update({ id: 'todoist:t1', title: '新しいタイトル' });

    expect(api.callsOf('getTask')).toEqual([]);
    expect(api.callsOf('updateTask')).toEqual([['t1', { content: '新しいタイトル' }]]);
  });

  it('sets and clears the due', async () => {
    const { api, connector } = setup();
    await connector.update({ id: 'todoist:t1', due: '2026-10-20T09:00:00+09:00' });
    expect(api.callsOf('updateTask')[0]?.[1]).toEqual({ dueDatetime: '2026-10-20T00:00:00Z' });

    const cleared = await connector.update({ id: 'todoist:t1', due: null });
    expect(api.callsOf('updateTask')[1]?.[1]).toEqual({ dueString: null });
    expect(cleared.due).toBeNull();
  });

  it('rejects a malformed id before calling Todoist', async () => {
    const { api, connector } = setup();
    expect(await rejection(connector.update({ id: 't1', title: 'a' }))).toBeInstanceOf(InputValidationError);
    expect(api.calls).toEqual([]);
  });

  it('reports a missing task', async () => {
    const { connector } = setup([]);
    const error = await rejection(connector.update({ id: 'todoist:nope', status: 'next' }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe('Not found: task todoist:nope');
  });
});

describe('complete', () => {
  it('closes a task and returns it as done', async () => {
    const { api, connector } = setup();
    const task = await connector.complete('todoist:t1');

    expect(api.callsOf('closeTask')).toEqual([['t1']]);
    expect(task).toMatchObject({ id: 'todoist:t1', status: 'done' });
  });

  it('returns the task as done when Todoist no longer returns it after closing', async () => {
    const { api, connector } = setup();
    api.closedTasksDisappear = true;
    expect(await connector.complete('todoist:t1')).toMatchObject({ id: 'todoist:t1', status: 'done', area: 'work' });
  });

  it('returns a recurring task still open with its next due', async () => {
    const { connector } = setup([
      todoistTask({
        id: 'r1',
        labels: ['af-next'],
        due: { isRecurring: true, string: 'every day', date: '2026-10-14' },
      }),
    ]);
    expect(await connector.complete('todoist:r1')).toMatchObject({ status: 'next', due: '2026-10-15' });
  });

  it('reports a missing task without closing anything', async () => {
    const { api, connector } = setup([]);
    expect(await rejection(connector.complete('todoist:nope'))).toBeInstanceOf(NotFoundError);
    expect(api.callsOf('closeTask')).toEqual([]);
  });
});

describe('errors', () => {
  it.each([
    [401, CredentialError, 'Credential error: Todoist rejected the API token (HTTP 401)'],
    [403, CredentialError, 'Credential error: Todoist rejected the API token (HTTP 403)'],
    [400, ProviderApiError, 'Todoist API error: HTTP 400: Bad Request'],
    [429, ProviderApiError, 'Todoist API error: HTTP 429: Bad Request'],
    [500, ProviderApiError, 'Todoist API error: HTTP 500: Bad Request'],
  ])('maps HTTP %i', async (status, type, message) => {
    const { api, connector } = setup();
    api.failures.addTask = new TodoistRequestError('Bad Request', status);
    const error = await rejection(connector.create({ title: 'a' }));
    expect(error).toBeInstanceOf(type);
    expect(error.message).toBe(message);
  });

  it('maps a network error to a provider error', async () => {
    const { api, connector } = setup();
    api.failures.getTasks = new TodoistRequestError('fetch failed');
    const error = await rejection(connector.list({}));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('Todoist API error: fetch failed');
  });
});

describe('lazyTodoistClient', () => {
  it('creates the client once from the credential provider', async () => {
    const factory = vi.fn(() => new FakeTodoistApi());
    const client = lazyTodoistClient(new EnvCredentialProvider({ TODOIST_API_TOKEN: 'secret-token' }), factory);
    await client();
    await client();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('secret-token');
  });

  it('reports a missing token without leaking anything, and retries later', async () => {
    const env: Record<string, string> = {};
    const factory = vi.fn(() => new FakeTodoistApi());
    const client = lazyTodoistClient(new EnvCredentialProvider(env), factory);
    const connector = new TodoistTaskConnector({ client, timeZone: TZ });

    const error = await rejection(connector.list({}));
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toContain('TODOIST_API_TOKEN');

    env.TODOIST_API_TOKEN = 'secret-token';
    await expect(connector.list({})).resolves.toEqual([]);
  });

  it('never puts the token in an error message', async () => {
    const { api, connector } = setup();
    api.failures.addTask = new TodoistRequestError('Unauthorized', 401);
    const error = await rejection(connector.create({ title: 'a' }));
    expect(error.message).not.toContain('secret-token');
  });
});
