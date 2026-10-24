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
import { badRequest, FakeTodoistApi, notFound, todoistTask } from './fake-api.js';

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

  describe('when reading the task back after closing fails', () => {
    /** Makes the first getTask after closeTask throw `error`. */
    function failReadBack(api: FakeTodoistApi, error: unknown): void {
      const close = api.closeTask;
      api.closeTask = (async (id: string) => {
        const closed = await close(id);
        api.failures.getTask = error;
        return closed;
      }) as typeof api.closeTask;
    }

    const recurring = () =>
      setup([
        todoistTask({ id: 'r1', labels: ['af-next'], due: { isRecurring: true, string: 'every day', date: '2026-10-14' } }),
      ]);

    it.each([
      ['a network error', new TodoistRequestError('fetch failed')],
      ['a server error', new TodoistRequestError('Service Unavailable', 503)],
      ['an authentication error', new TodoistRequestError('Unauthorized', 401)],
    ])('reports %s instead of returning done', async (_label, failure) => {
      const { api, connector } = recurring();
      failReadBack(api, failure);

      const error = await rejection(connector.complete('todoist:r1'));
      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error.message).toContain('task todoist:r1 was closed, but its state afterwards could not be read');
      expect(api.callsOf('closeTask')).toEqual([['r1']]);
    });

    it('still treats a task gone after closing as done', async () => {
      const { api, connector } = setup();
      failReadBack(api, notFound());
      expect(await connector.complete('todoist:t1')).toMatchObject({ id: 'todoist:t1', status: 'done' });
    });
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

describe('recurrence', () => {
  const weekly = (overrides: Partial<Parameters<typeof todoistTask>[0]> = {}) =>
    todoistTask({
      id: 'r1',
      content: 'ゴミ出し',
      labels: ['af-next', 'x'],
      due: { isRecurring: true, string: 'every monday', date: '2026-10-19', timezone: null, lang: 'en' },
      ...overrides,
    });

  /** Makes the `nth` (1-based) call of updateTask throw `error`. */
  function failUpdate(api: FakeTodoistApi, nth: number, error: unknown): void {
    const update = api.updateTask;
    let count = 0;
    api.updateTask = (async (...args: Parameters<typeof update>) => {
      count += 1;
      if (count === nth) api.failures.updateTask = error;
      return update(...args);
    }) as typeof update;
  }

  const dueKeys = (args: unknown) =>
    Object.keys(args as object).filter((key) => ['dueString', 'dueLang', 'dueDate', 'dueDatetime'].includes(key));

  describe('create', () => {
    it('sends the rule as an English dueString and returns it with the next due', async () => {
      const { api, connector } = setup([]);
      const task = await connector.create({ title: 'ゴミ出し', status: 'next', recurrence: 'every monday' });

      expect(api.callsOf('addTask')[0]?.[0]).toEqual({
        content: 'ゴミ出し',
        labels: ['af-next'],
        dueString: 'every monday',
        dueLang: 'en',
      });
      expect(task).toMatchObject({ status: 'next', due: '2026-10-26', recurrence: 'every monday' });
      expect(api.callsOf('deleteTask')).toEqual([]);
    });

    it('returns no recurrence and never deletes without a rule', async () => {
      const { api, connector } = setup([]);
      expect(await connector.create({ title: 'a', due: '2026-10-16' })).toMatchObject({ recurrence: null });
      expect(api.callsOf('deleteTask')).toEqual([]);
    });

    it('deletes the task it added when Todoist reads the rule as a one-off due', async () => {
      const { api, connector } = setup([]);
      const error = await rejection(connector.create({ title: 'a', status: 'next', tags: ['y'], recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toBe(
        'Invalid input: Todoist did not read recurrence "tomorrow" as a recurring rule ' +
          '(it was read as the one-off due 2026-10-26), so no task was created. ' +
          'Use a rule such as "every monday" or "every! 3 days".',
      );
      expect(api.callsOf('deleteTask')).toEqual([['100']]);
      expect(api.tasks.size).toBe(0);
      expect(api.callsOf('updateTask')).toEqual([]);
    });

    it('counts an unconfirmed deletion as done once the task is gone', async () => {
      const { api, connector } = setup([]);
      const deleteTask = api.deleteTask;
      api.deleteTask = (async (id: string) => {
        await deleteTask(id); // the request reached Todoist, but its answer was lost
        throw new TodoistRequestError('fetch failed');
      }) as typeof deleteTask;

      expect(await rejection(connector.create({ title: 'a', recurrence: 'tomorrow' }))).toBeInstanceOf(InputValidationError);
      expect(api.callsOf('getTask')).toEqual([['100']]);
    });

    it('reports a task that still exists when Todoist does not confirm the deletion', async () => {
      const { api, connector } = setup([]);
      api.deleteResult = false;
      const error = await rejection(connector.create({ title: 'a', recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error.message).toContain(
        'task todoist:100 was created, but deleting it failed: Todoist did not confirm the deletion',
      );
      expect(error.message).toContain('The task still exists');
      expect(error.message).toContain('do not call task_create again');
      expect(api.tasks.has('100')).toBe(true);
    });

    it('reports a task that may still exist when neither the deletion nor a read-back succeeds', async () => {
      const { api, connector } = setup([]);
      api.failures.deleteTask = new TodoistRequestError('fetch failed');
      api.failures.getTask = new TodoistRequestError('fetch failed');
      const error = await rejection(connector.create({ title: 'a', recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error.message).toContain('deleting it failed: Todoist API error: fetch failed');
      expect(error.message).toContain('The task may still exist');
    });

    it('reports a rejected rule as input to check without claiming why', async () => {
      const { api, connector } = setup([]);
      const failure = badRequest();
      api.failures.addTask = failure;
      const error = await rejection(connector.create({ title: 'a', recurrence: 'every blah' }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toBe(
        'Invalid input: Todoist rejected the request with recurrence "every blah" (HTTP 400). ' +
          'Check the rule syntax, e.g. "every monday" or "every! 3 days".',
      );
      expect(error.message).not.toContain('parse');
      expect(error.cause).toBe(failure);
      expect(api.callsOf('deleteTask')).toEqual([]);
    });

    it('keeps other failures of a request with a rule as they were', async () => {
      const { api, connector } = setup([]);
      api.failures.addTask = new TodoistRequestError('Service Unavailable', 503);
      expect(await rejection(connector.create({ title: 'a', recurrence: 'every day' }))).toBeInstanceOf(ProviderApiError);
    });
  });

  describe('update', () => {
    it('keeps the rule when only the title changes, without reading the task', async () => {
      const { api, connector } = setup([weekly()]);
      const task = await connector.update({ id: 'todoist:r1', title: '資源ごみ' });

      expect(api.callsOf('getTask')).toEqual([]);
      expect(api.callsOf('updateTask')).toEqual([['r1', { content: '資源ごみ' }]]);
      expect(task).toMatchObject({ title: '資源ごみ', due: '2026-10-19', recurrence: 'every monday' });
    });

    it('keeps the rule when status, area and tags change', async () => {
      const { api, connector } = setup([weekly()]);
      const task = await connector.update({ id: 'todoist:r1', status: 'waiting', area: 'personal', tags: ['z'] });

      expect(dueKeys(api.callsOf('updateTask')[0]?.[1])).toEqual([]);
      expect(api.tasks.get('r1')?.due).toEqual(weekly().due);
      expect(task).toMatchObject({ status: 'waiting', area: 'personal', tags: ['z'], recurrence: 'every monday' });
    });

    it('changes the rule', async () => {
      const { api, connector } = setup([weekly()]);
      const task = await connector.update({ id: 'todoist:r1', recurrence: 'every day' });

      expect(api.callsOf('getTask')).toEqual([['r1']]);
      expect(api.callsOf('updateTask')).toEqual([['r1', { dueString: 'every day', dueLang: 'en' }]]);
      expect(task).toMatchObject({ recurrence: 'every day', due: '2026-10-26' });
    });

    it('makes a one-off task recurring', async () => {
      const { connector } = setup();
      expect(await connector.update({ id: 'todoist:t1', recurrence: 'every! 3 days' })).toMatchObject({
        recurrence: 'every! 3 days',
      });
    });

    it.each([
      ['a recurring task', () => weekly()],
      ['a one-off task', () => weekly({ due: { isRecurring: false, string: '1 Dec', date: '2026-12-01' } })],
    ])('removes the rule and the due of %s with recurrence: null', async (_label, task) => {
      const { api, connector } = setup([task()]);
      const updated = await connector.update({ id: 'todoist:r1', recurrence: null });

      expect(api.callsOf('updateTask')).toEqual([['r1', { dueString: null }]]);
      expect(updated).toMatchObject({ due: null, recurrence: null });
    });

    it.each([
      ['a date', { due: '2026-11-01' }],
      ['a date-time', { due: '2026-11-01T09:00:00+09:00' }],
      ['null', { due: null }],
      ['a due with other fields', { due: '2026-11-01', title: 'b', tags: ['z'] }],
    ])('rejects changing the due of a recurring task to %s before writing anything', async (_label, fields) => {
      const { api, connector } = setup([weekly()]);
      const before = structuredClone(api.tasks.get('r1'));
      const error = await rejection(connector.update({ id: 'todoist:r1', ...fields }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toBe(
        'Invalid input: task todoist:r1 recurs ("every monday"); changing its due would remove the recurrence. ' +
          'Change the rule with recurrence, or remove the rule and the due with recurrence: null. Nothing was changed.',
      );
      expect(api.callsOf('updateTask')).toEqual([]);
      expect(api.tasks.get('r1')).toEqual(before);
    });

    it('still changes the due of a one-off task or a task without a due', async () => {
      const { api, connector } = setup([todoistTask({ id: 't1' }), todoistTask({ id: 't2', due: null })]);
      await connector.update({ id: 'todoist:t1', due: '2026-11-01', title: 'b' });
      await connector.update({ id: 'todoist:t2', due: null });

      expect(api.callsOf('getTask')).toEqual([['t1'], ['t2']]);
      expect(api.callsOf('updateTask')).toEqual([
        ['t1', { content: 'b', dueDate: '2026-11-01' }],
        ['t2', { dueString: null }],
      ]);
    });

    it('puts a recurring due back when Todoist reads the new rule as a one-off due', async () => {
      const due = { isRecurring: true, string: 'every monday', date: '2026-10-26', timezone: null, lang: 'en' };
      const { api, connector } = setup([weekly({ due })]);
      const before = structuredClone(api.tasks.get('r1'));
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toBe(
        'Invalid input: Todoist did not read recurrence "tomorrow" as a recurring rule; ' +
          'task todoist:r1 was left as before ("every monday", next 2026-10-26).',
      );
      expect(api.callsOf('updateTask')[1]).toEqual(['r1', { dueString: 'every monday', dueLang: 'en' }]);
      expect(api.tasks.get('r1')).toEqual(before);
    });

    it('says when putting a rule back moved its next due', async () => {
      const { api, connector } = setup([weekly()]);
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'tomorrow' }));

      expect(error.message).toContain('was left as before ("every monday", next 2026-10-19).');
      expect(error.message).toContain(
        'Its previous rule "every monday" was set again, and Todoist recalculated the next due (now 2026-10-26).',
      );
      expect(api.tasks.get('r1')).toMatchObject({ content: 'ゴミ出し', labels: ['af-next', 'x'] });
      expect(api.tasks.get('r1')?.due).toMatchObject({ isRecurring: true, string: 'every monday' });
    });

    it('puts a Japanese rule back in its own language', async () => {
      const due = { isRecurring: true, string: '毎日', date: '2026-10-26', timezone: null, lang: 'ja' };
      const { api, connector } = setup([weekly({ due })]);
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(api.callsOf('updateTask')[1]).toEqual(['r1', { dueString: '毎日', dueLang: 'ja' }]);
      expect(api.tasks.get('r1')?.due).toMatchObject({ isRecurring: true, string: '毎日', lang: 'ja' });
    });

    it('puts back a time that is not in the rule text by setting a timed rule first', async () => {
      // "every day" that kept 09:00 from an earlier "every day at 9am".
      const due = { isRecurring: true, string: 'every day', date: '2026-10-19T09:00:00', timezone: null, lang: 'en' };
      const { api, connector } = setup([weekly({ due })]);
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'no date' }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toContain('task todoist:r1 was left as before ("every day", next 2026-10-19T09:00:00+09:00).');
      expect(api.callsOf('updateTask').slice(1)).toEqual([
        ['r1', { dueString: 'every day at 09:00', dueLang: 'en' }],
        ['r1', { dueString: 'every day', dueLang: 'en' }],
      ]);
      expect(api.tasks.get('r1')?.due).toMatchObject({ isRecurring: true, string: 'every day', date: '2026-10-26T09:00:00' });
    });

    it('reports the state left when Todoist does not take the previous rule back', async () => {
      // A rule the fake (like Todoist for some texts) does not read as recurring when sent again.
      const due = { isRecurring: true, string: 'ev mon', date: '2026-10-19', timezone: null, lang: 'en' };
      const { api, connector } = setup([weekly({ due })]);
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error.message).toBe(
        'Todoist API error: Todoist did not read recurrence "tomorrow" as a recurring rule, and restoring the previous ' +
          'due of task todoist:r1 ("ev mon", next 2026-10-19) did not take effect: it now has the one-off due 2026-10-26. ' +
          'Fix it with task_update or in Todoist.',
      );
      expect(api.tasks.get('r1')?.due?.isRecurring).toBe(false);
    });

    it('reports the state left when the first of two restore steps fails', async () => {
      const due = { isRecurring: true, string: 'every day', date: '2026-10-19T09:00:00', timezone: null, lang: 'en' };
      const { api, connector } = setup([weekly({ due })]);
      failUpdate(api, 2, new TodoistRequestError('Service Unavailable', 503));
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'no date' }));

      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error.message).toContain('task todoist:r1 now has no due; restoring its previous due');
      expect(api.callsOf('updateTask')).toHaveLength(2);
    });

    it.each([
      ['a date', { isRecurring: false, string: '1 Dec', date: '2026-12-01' }, { dueDate: '2026-12-01' }],
      [
        'a date-time',
        { isRecurring: false, string: '20 Nov 09:00', date: '2026-11-20T00:00:00Z', timezone: 'Asia/Tokyo' },
        { dueDatetime: '2026-11-20T00:00:00Z' },
      ],
      ['no due', null, { dueString: null }],
    ])('puts back %s', async (_label, due, restoreArgs) => {
      const { api, connector } = setup([todoistTask({ id: 't1', due })]);
      const before = structuredClone(api.tasks.get('t1'));
      const error = await rejection(connector.update({ id: 'todoist:t1', recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(api.callsOf('updateTask')[1]).toEqual(['t1', restoreArgs]);
      if (due === null) expect(api.tasks.get('t1')).toEqual(before);
    });

    it('reports the current and previous due when putting it back fails', async () => {
      const { api, connector } = setup([weekly()]);
      failUpdate(api, 2, new TodoistRequestError('Service Unavailable', 503));
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'tomorrow' }));

      expect(error).toBeInstanceOf(ProviderApiError);
      expect(error.message).toBe(
        'Todoist API error: Todoist did not read recurrence "tomorrow" as a recurring rule and task todoist:r1 now has ' +
          'the one-off due 2026-10-26; restoring its previous due ("every monday", next 2026-10-19) failed: ' +
          'Todoist API error: HTTP 503: Service Unavailable',
      );
    });

    it('reports a rejected rule as input to check, without putting anything back', async () => {
      const { api, connector } = setup([weekly()]);
      api.failures.updateTask = badRequest();
      const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'every blah' }));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toContain('Todoist rejected the request with recurrence "every blah" (HTTP 400)');
      expect(api.callsOf('updateTask')).toHaveLength(1);
    });

    it('keeps a 400 of an update without a rule as a provider error', async () => {
      const { api, connector } = setup();
      api.failures.updateTask = badRequest();
      expect(await rejection(connector.update({ id: 'todoist:t1', title: 'b' }))).toBeInstanceOf(ProviderApiError);
    });

    it.each([
      ['recurrence', { recurrence: 'every day' }],
      ['due', { due: '2026-11-01' }],
    ])('reports a missing task without writing when %s is given', async (_label, fields) => {
      const { api, connector } = setup([]);
      expect(await rejection(connector.update({ id: 'todoist:nope', ...fields }))).toBeInstanceOf(NotFoundError);
      expect(api.callsOf('updateTask')).toEqual([]);
    });
  });

  describe('complete', () => {
    it('moves a recurring task to its next due and keeps the rule', async () => {
      const { connector } = setup([weekly()]);
      expect(await connector.complete('todoist:r1')).toMatchObject({
        status: 'next',
        due: '2026-10-20',
        recurrence: 'every monday',
      });
    });

    it('completes a one-off task without a recurrence', async () => {
      const { connector } = setup();
      expect(await connector.complete('todoist:t1')).toMatchObject({ status: 'done', recurrence: null });
    });
  });
});
