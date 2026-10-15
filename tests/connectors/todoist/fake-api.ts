import { TodoistRequestError } from '@doist/todoist-sdk';
import type { TodoistClient, TodoistTask } from '../../../src/connectors/todoist/client.js';

export function todoistTask(overrides: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id: 't1',
    userId: 'u1',
    projectId: 'inbox-project',
    sectionId: null,
    parentId: null,
    addedByUid: null,
    assignedByUid: null,
    responsibleUid: null,
    labels: [],
    deadline: null,
    duration: null,
    checked: false,
    isDeleted: false,
    addedAt: null,
    completedAt: null,
    updatedAt: null,
    due: null,
    priority: 1,
    childOrder: 1,
    content: 'task',
    description: '',
    dayOrder: 0,
    isCollapsed: false,
    ...overrides,
  } as TodoistTask;
}

export const notFound = () => new TodoistRequestError('Not Found', 404);

type Call = { method: string; args: unknown[] };

/**
 * In-memory stand-in for the SDK methods the connector uses. Closing a recurring task advances
 * its due by one day and keeps it open; closing any other task marks it checked, or removes it
 * when `closedTasksDisappear` is set (both behaviours are handled by the connector).
 */
export class FakeTodoistApi implements TodoistClient {
  readonly calls: Call[] = [];
  tasks = new Map<string, TodoistTask>();
  inboxProjectId = 'inbox-project';
  pageSize = 2;
  closedTasksDisappear = false;
  /** Thrown by the next call of the named method. */
  failures: Partial<Record<keyof TodoistClient, unknown>> = {};
  private nextId = 100;

  constructor(tasks: TodoistTask[] = []) {
    for (const task of tasks) this.tasks.set(task.id, task);
  }

  private call(method: keyof TodoistClient, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failures[method];
    if (failure !== undefined) {
      delete this.failures[method];
      throw failure;
    }
  }

  callsOf(method: keyof TodoistClient): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  getUser = (async () => {
    this.call('getUser');
    return { id: 'u1', inboxProjectId: this.inboxProjectId };
  }) as unknown as TodoistClient['getUser'];

  getTasks = (async (args: { projectId?: string; cursor?: string | null; limit?: number } = {}) => {
    this.call('getTasks', args);
    const all = [...this.tasks.values()].filter((task) => !args.projectId || task.projectId === args.projectId);
    const start = Number(args.cursor ?? 0);
    const results = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return { results, nextCursor: next < all.length ? String(next) : null };
  }) as unknown as TodoistClient['getTasks'];

  getTask = (async (id: string) => {
    this.call('getTask', id);
    const task = this.tasks.get(id);
    if (!task) throw notFound();
    return task;
  }) as unknown as TodoistClient['getTask'];

  addTask = (async (args: Record<string, unknown>) => {
    this.call('addTask', args);
    const id = String(this.nextId++);
    const task = todoistTask({
      id,
      content: args.content as string,
      labels: (args.labels as string[]) ?? [],
      projectId: (args.projectId as string) ?? this.inboxProjectId,
      due: dueFromArgs(args),
    });
    this.tasks.set(id, task);
    return task;
  }) as unknown as TodoistClient['addTask'];

  updateTask = (async (id: string, args: Record<string, unknown>) => {
    this.call('updateTask', id, args);
    const task = this.tasks.get(id);
    if (!task) throw notFound();
    const updated = todoistTask({
      ...task,
      ...(args.content !== undefined ? { content: args.content as string } : {}),
      ...(args.labels !== undefined ? { labels: args.labels as string[] } : {}),
      ...('dueString' in args || 'dueDate' in args || 'dueDatetime' in args ? { due: dueFromArgs(args) } : {}),
    });
    this.tasks.set(id, updated);
    return updated;
  }) as unknown as TodoistClient['updateTask'];

  closeTask = (async (id: string) => {
    this.call('closeTask', id);
    const task = this.tasks.get(id);
    if (!task) throw notFound();
    if (task.due?.isRecurring) {
      const next = new Date(Date.parse(`${task.due.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      this.tasks.set(id, { ...task, due: { ...task.due, date: next } });
    } else if (this.closedTasksDisappear) {
      this.tasks.delete(id);
    } else {
      this.tasks.set(id, { ...task, checked: true });
    }
    return true;
  }) as unknown as TodoistClient['closeTask'];
}

function dueFromArgs(args: Record<string, unknown>): TodoistTask['due'] {
  if (typeof args.dueDate === 'string') {
    return { isRecurring: false, string: args.dueDate, date: args.dueDate, datetime: null, timezone: null };
  }
  if (typeof args.dueDatetime === 'string') {
    const datetime = args.dueDatetime;
    return { isRecurring: false, string: datetime, date: datetime.slice(0, 10), datetime, timezone: 'Asia/Tokyo' };
  }
  return null;
}
