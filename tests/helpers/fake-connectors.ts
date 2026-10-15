import type { CollectionConnector, ScheduleConnector, TaskConnector } from '../../src/connectors/types.js';
import { type CollectionItem, mergeMetadata, type Schedule, type Task } from '../../src/domain/index.js';

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

/** In-memory collection connector that records the domain input of every call. */
export class FakeCollectionConnector implements CollectionConnector {
  readonly calls: { method: keyof CollectionConnector; arg: unknown }[] = [];
  failWith: Error | undefined;
  items: CollectionItem[] = [];

  private record(method: keyof CollectionConnector, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.failWith) throw this.failWith;
  }

  async create(input: Parameters<CollectionConnector['create']>[0]): Promise<CollectionItem> {
    this.record('create', input);
    const item: CollectionItem = {
      id: `notion:${this.items.length + 1}`,
      source: 'notion',
      external_ref: `https://www.notion.so/${this.items.length + 1}`,
      type: 'collection',
      title: input.title,
      collection_type: input.collection_type,
      status: input.status,
      metadata: input.metadata ?? {},
      tags: input.tags ?? [],
    };
    this.items.push(item);
    return item;
  }

  async search(filter: Parameters<CollectionConnector['search']>[0]): Promise<CollectionItem[]> {
    this.record('search', filter);
    return this.items;
  }

  async update(input: Parameters<CollectionConnector['update']>[0]): Promise<CollectionItem> {
    this.record('update', input);
    const current = this.items.find((item) => item.id === input.id) ?? {
      id: input.id,
      type: 'collection',
      title: 'existing',
      collection_type: 'other',
      status: 'wishlist',
      metadata: {},
      tags: [],
    };
    return {
      ...current,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.metadata ? { metadata: mergeMetadata(current.metadata ?? {}, input.metadata) } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    };
  }
}
