import { TodoistApi } from '@doist/todoist-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyTodoistClient } from '../../src/connectors/todoist/client.js';
import { TodoistTaskConnector } from '../../src/connectors/todoist/connector.js';
import { parseTaskId } from '../../src/connectors/todoist/mapping.js';
import { credentials, daysFromToday, enabled, hasEnv, integrationConfig, runLabel } from './setup.js';

const run = enabled && hasEnv('TODOIST_API_TOKEN');

describe.runIf(run)('Todoist (real API)', () => {
  let connector: TodoistTaskConnector;
  let raw: TodoistApi;
  const created: string[] = [];

  beforeAll(async () => {
    const config = await integrationConfig();
    connector = new TodoistTaskConnector({
      client: lazyTodoistClient(credentials),
      timeZone: config.defaults.timezone,
    });
    raw = new TodoistApi(await credentials.getTodoistApiToken());
  });

  afterAll(async () => {
    // Test tasks are deleted outright; the connector itself never deletes.
    await Promise.allSettled(created.map((id) => raw?.deleteTask(id)));
  });

  it('creates, lists, updates and completes a task in the Inbox', async () => {
    const due = daysFromToday(3);
    const task = await connector.create({
      title: `${runLabel} 経費精算`,
      status: 'next',
      due,
      area: 'work',
      tags: ['ai-foundation-it'],
    });
    const todoistId = parseTaskId(task.id!);
    created.push(todoistId);

    expect(task).toMatchObject({ status: 'next', due, area: 'work', tags: ['ai-foundation-it'] });
    const stored = await raw.getTask(todoistId);
    const { inboxProjectId } = await raw.getUser();
    expect(stored.projectId).toBe(inboxProjectId);
    expect([...stored.labels].sort()).toEqual(['af-area-work', 'af-next', 'ai-foundation-it']);

    const listed = await connector.list({ status: ['next'], area: 'work', tags: ['ai-foundation-it'], due_before: due });
    expect(listed.map((t) => t.id)).toContain(task.id);

    const updated = await connector.update({
      id: task.id!,
      status: 'waiting',
      area: null,
      tags: ['ai-foundation-it-2'],
      due: null,
    });
    expect(updated).toMatchObject({ status: 'waiting', area: null, tags: ['ai-foundation-it-2'], due: null });
    expect([...(await raw.getTask(todoistId)).labels].sort()).toEqual(['af-waiting', 'ai-foundation-it-2']);

    const dueAt = `${daysFromToday(4)}T18:00:00+09:00`;
    const timed = await connector.update({ id: task.id!, due: dueAt });
    expect(Date.parse(timed.due!)).toBe(Date.parse(dueAt));

    const done = await connector.complete(task.id!);
    expect(done.status).toBe('done');
    expect((await connector.list({})).map((t) => t.id)).not.toContain(task.id);
  });

  it('keeps af- labels it does not know when tags are replaced', async () => {
    const added = await raw.addTask({ content: `${runLabel} labels`, labels: ['af-next', 'af-future', 'old'] });
    created.push(added.id);

    const updated = await connector.update({ id: `todoist:${added.id}`, tags: ['new'] });
    expect(updated).toMatchObject({ status: 'next', tags: ['new'] });
    expect([...(await raw.getTask(added.id)).labels].sort()).toEqual(['af-future', 'af-next', 'new']);
  });

  it('returns a recurring task still open after completing it', async () => {
    const added = await raw.addTask({ content: `${runLabel} recurring`, dueString: 'every day' });
    created.push(added.id);

    const after = await connector.complete(`todoist:${added.id}`);
    expect(after.status).not.toBe('done');
    expect(after.due).not.toBe(added.due?.date);
  });
});
