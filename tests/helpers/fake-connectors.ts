import type { ScheduleConnector, TaskConnector } from '../../src/connectors/types.js';
import type { Schedule, Task } from '../../src/domain/index.js';

/** In-memory task connector that records the domain input of every call. */
export class FakeTaskConnector implements TaskConnector {
  readonly calls: { method: keyof TaskConnector; arg: unknown }[] = [];
  /** When set, every method throws it instead of returning. */
  failWith: Error | undefined;
  tasks: Task[] = [];

  private record(method: keyof TaskConnector, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.failWith) throw this.failWith;
  }

  async create(input: Parameters<TaskConnector['create']>[0]): Promise<Task> {
    this.record('create', input);
    const task: Task = {
      id: `todoist:${this.tasks.length + 1}`,
      source: 'todoist',
      type: 'task',
      title: input.title,
      status: input.status ?? 'inbox',
      due: input.due ?? null,
      area: input.area ?? null,
      project_ref: null,
      tags: input.tags ?? [],
    };
    this.tasks.push(task);
    return task;
  }

  async list(filter: Parameters<TaskConnector['list']>[0]): Promise<Task[]> {
    this.record('list', filter);
    return this.tasks;
  }

  async update(input: Parameters<TaskConnector['update']>[0]): Promise<Task> {
    this.record('update', input);
    const { id, ...fields } = input;
    return { ...this.find(id), ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  }

  async complete(id: string): Promise<Task> {
    this.record('complete', id);
    return { ...this.find(id), status: 'done' };
  }

  private find(id: string): Task {
    return this.tasks.find((task) => task.id === id) ?? { id, type: 'task', title: 'existing', status: 'inbox' };
  }
}

/** In-memory schedule connector that records the domain input of every call. */
export class FakeScheduleConnector implements ScheduleConnector {
  readonly calls: { method: keyof ScheduleConnector; arg: unknown }[] = [];
  failWith: Error | undefined;
  schedules: Schedule[] = [];

  async create(input: Parameters<ScheduleConnector['create']>[0]): Promise<Schedule> {
    this.calls.push({ method: 'create', arg: input });
    if (this.failWith) throw this.failWith;
    return {
      id: 'google_calendar:af@group.calendar.google.com:evt1',
      source: 'google_calendar',
      type: 'schedule',
      title: input.title,
      start: input.start,
      end: input.end ?? null,
    };
  }

  async list(filter: Parameters<ScheduleConnector['list']>[0]): Promise<Schedule[]> {
    this.calls.push({ method: 'list', arg: filter });
    if (this.failWith) throw this.failWith;
    return this.schedules;
  }
}
