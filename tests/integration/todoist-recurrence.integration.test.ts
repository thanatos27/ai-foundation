import { TodoistApi } from '@doist/todoist-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyTodoistClient } from '../../src/connectors/todoist/client.js';
import { TodoistTaskConnector } from '../../src/connectors/todoist/connector.js';
import { parseTaskId } from '../../src/connectors/todoist/mapping.js';
import type { Task } from '../../src/domain/index.js';
import { InputValidationError, type FoundationError } from '../../src/errors.js';
import { credentials, daysFromToday, enabled, hasEnv, integrationConfig, runLabel } from './setup.js';

const run = enabled && hasEnv('TODOIST_API_TOKEN');

/**
 * Recurring tasks against the real Todoist. Only tasks this run creates are touched, and they are
 * deleted at the end. Todoist may reword a rule (e.g. "after 3 days" → "every! 3 days"), so rules
 * are checked against what Todoist stores, not against the input.
 */
describe.runIf(run)('Todoist recurring tasks (real API)', () => {
  let connector: TodoistTaskConnector;
  let raw: TodoistApi;
  let inboxProjectId: string;
  const created: string[] = [];

  beforeAll(async () => {
    const config = await integrationConfig();
    connector = new TodoistTaskConnector({ client: lazyTodoistClient(credentials), timeZone: config.defaults.timezone });
    raw = new TodoistApi(await credentials.getTodoistApiToken());
    inboxProjectId = (await raw.getUser()).inboxProjectId;
  });

  afterAll(async () => {
    // Test tasks are deleted outright.
    await Promise.allSettled(created.map((id) => raw?.deleteTask(id)));
  });

  async function create(input: Parameters<TodoistTaskConnector['create']>[0]): Promise<Task> {
    const task = await connector.create(input);
    created.push(parseTaskId(task.id!));
    return task;
  }

  const stored = (task: Task) => raw.getTask(parseTaskId(task.id!));
  const snapshot = async (task: Task) => {
    const { content, labels, due } = await stored(task);
    return { content, labels: [...labels].sort(), due };
  };

  async function failure(promise: Promise<unknown>): Promise<FoundationError> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e as FoundationError,
    );
    expect(error).toBeDefined();
    return error!;
  }

  it('creates, keeps, changes, completes and removes a recurring rule', async () => {
    // I1: create
    const task = await create({
      title: `${runLabel} ゴミ出し`,
      recurrence: 'every monday',
      status: 'next',
      area: 'work',
      tags: ['ai-foundation-it'],
    });
    const first = await stored(task);
    expect(first.due?.isRecurring).toBe(true);
    expect(task.recurrence).toBe(first.due?.string);
    expect(task.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${task.due}T00:00:00Z`).getUTCDay()).toBe(1);
    expect((await connector.list({ tags: ['ai-foundation-it'] })).find((t) => t.id === task.id)?.recurrence).toBe(
      task.recurrence,
    );

    // I2: title / status / area / tags keep the rule and the next due
    for (const change of [{ title: `${runLabel} 資源ごみ` }, { status: 'waiting' as const }, { area: null }, { tags: ['ai-foundation-it-2'] }]) {
      const updated = await connector.update({ id: task.id!, ...change });
      expect(updated.recurrence).toBe(task.recurrence);
      expect((await stored(task)).due).toEqual(first.due);
    }

    // I3: a due change is rejected without writing
    for (const change of [{ due: daysFromToday(10) }, { due: null, title: 'x' }]) {
      const before = await snapshot(task);
      expect(await failure(connector.update({ id: task.id!, ...change }))).toBeInstanceOf(InputValidationError);
      expect(await snapshot(task)).toEqual(before);
    }

    // I4: change the rule
    const daily = await connector.update({ id: task.id!, recurrence: 'every day' });
    expect((await stored(task)).due?.isRecurring).toBe(true);
    expect(daily.recurrence).toBe((await stored(task)).due?.string);
    expect(daily.recurrence).not.toBe(task.recurrence);

    // I5: complete moves to the next occurrence and keeps the rule
    const done = await connector.complete(task.id!);
    expect(done.status).not.toBe('done');
    expect(done.recurrence).toBe(daily.recurrence);
    expect(done.due! > daily.due!).toBe(true);

    // I6: remove the rule together with the due
    const removed = await connector.update({ id: task.id!, recurrence: null });
    expect(removed).toMatchObject({ due: null, recurrence: null });
    expect((await stored(task)).due).toBeNull();
  });

  it('counts a completion-based rule from the completion date', async () => {
    // I7
    const task = await create({ title: `${runLabel} 水やり`, recurrence: 'every! 3 days' });
    expect(task.recurrence).toBe('every! 3 days');
    const after = await connector.complete(task.id!);
    expect(after).toMatchObject({ recurrence: 'every! 3 days' });
    expect(after.status).not.toBe('done');
  });

  it('creates nothing when Todoist reads the rule as a one-off due', async () => {
    // I8
    const title = `${runLabel} not recurring`;
    const error = await failure(connector.create({ title, recurrence: 'tomorrow' }));
    const leftover = /todoist:([A-Za-z0-9_-]+)/.exec(error.message)?.[1];
    if (leftover) created.push(leftover);

    expect(error).toBeInstanceOf(InputValidationError);
    const inbox = await raw.getTasks({ projectId: inboxProjectId, limit: 200 });
    expect(inbox.results.filter((t) => t.content === title)).toEqual([]);
  });

  it('leaves a task as it was when Todoist reads a new rule as a one-off due', async () => {
    // I9
    const task = await create({ title: `${runLabel} rule kept`, recurrence: 'every day' });
    const before = await snapshot(task);

    expect(await failure(connector.update({ id: task.id!, recurrence: 'tomorrow' }))).toBeInstanceOf(InputValidationError);
    const after = await snapshot(task);
    expect(after).toMatchObject({ content: before.content, labels: before.labels });
    expect(after.due).toMatchObject({ isRecurring: true, string: before.due?.string });
  });

  it('puts back a time that is not in the rule text', async () => {
    // "every day" keeps 09:00 from "every day at 9am"; a failed change must not drop that time.
    const task = await create({ title: `${runLabel} time kept`, recurrence: 'every day at 9am' });
    await connector.update({ id: task.id!, recurrence: 'every day' });
    const before = (await stored(task)).due;
    expect(before).toMatchObject({ isRecurring: true, string: 'every day' });
    expect(before?.date).toMatch(/T09:00:00$/);

    for (const rule of ['tomorrow', 'no date']) {
      expect(await failure(connector.update({ id: task.id!, recurrence: rule }))).toBeInstanceOf(InputValidationError);
      const after = (await stored(task)).due;
      expect(after).toMatchObject({ isRecurring: true, string: 'every day', timezone: before?.timezone ?? null });
      expect(after?.date).toMatch(/T09:00:00$/);
    }
  });

  it('reports a rule Todoist rejects as input to check', async () => {
    const error = await failure(connector.create({ title: `${runLabel} rejected`, recurrence: 'every blah' }));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain('HTTP 400');
  });

  it('still changes the due of a one-off task', async () => {
    // I10
    const task = await create({ title: `${runLabel} one-off`, due: daysFromToday(3) });
    const due = daysFromToday(5);
    expect(await connector.update({ id: task.id!, due })).toMatchObject({ due, recurrence: null });
  });
});
