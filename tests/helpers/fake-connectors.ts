import type {
  AreaConnector,
  CollectionConnector,
  KnowledgeConnector,
  LifeLogConnector,
  ProjectConnector,
  ScheduleConnector,
  TaskConnector,
} from '../../src/connectors/types.js';
import {
  type AreaGetResult,
  type AreaResource,
  type CollectionItem,
  type Knowledge,
  type KnowledgeSearchResult,
  type LifeLog,
  type LifeLogDocument,
  mergeMetadata,
  type ProjectGetResult,
  type ProjectResult,
  type Schedule,
  type Task,
} from '../../src/domain/index.js';

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
      recurrence: input.recurrence ?? null,
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
      calendar: input.calendar ?? 'personal',
      title: input.title,
      start: input.start,
      end: input.end ?? null,
      description: input.description ?? null,
      location: input.location ?? null,
    };
  }

  async list(filter: Parameters<ScheduleConnector['list']>[0]): Promise<Schedule[]> {
    this.calls.push({ method: 'list', arg: filter });
    if (this.failWith) throw this.failWith;
    return this.schedules;
  }

  async update(input: Parameters<ScheduleConnector['update']>[0]): Promise<Schedule> {
    this.calls.push({ method: 'update', arg: input });
    if (this.failWith) throw this.failWith;
    return {
      id: input.id,
      source: 'google_calendar',
      type: 'schedule',
      calendar: 'personal',
      title: input.title ?? 'a',
      start: input.start ?? '2026-10-19',
      end: input.end ?? null,
      description: input.description ?? null,
      location: input.location ?? null,
    };
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

/** In-memory knowledge connector that records the domain input of every call. */
export class FakeKnowledgeConnector implements KnowledgeConnector {
  readonly calls: { method: keyof KnowledgeConnector; arg: unknown }[] = [];
  failWith: Error | undefined;
  items: Knowledge[] = [];

  private record(method: keyof KnowledgeConnector, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.failWith) throw this.failWith;
  }

  async create(input: Parameters<KnowledgeConnector['create']>[0]): Promise<Knowledge> {
    this.record('create', input);
    const path = `AI Foundation/Knowledge/${input.title}.md`;
    const knowledge: Knowledge = {
      id: `obsidian:${path}`,
      type: 'knowledge',
      title: input.title,
      description: input.description ?? null,
      source: 'obsidian',
      external_ref: path,
      area: input.area,
      tags: input.tags ?? [],
    };
    this.items.push(knowledge);
    return knowledge;
  }

  async search(filter: Parameters<KnowledgeConnector['search']>[0]): Promise<KnowledgeSearchResult[]> {
    this.record('search', filter);
    return this.items.map((item) => ({ ...item, snippet: 'snippet' }));
  }

  async get(id: string): Promise<{ knowledge: Knowledge; content: string }> {
    this.record('get', id);
    return { knowledge: this.find(id), content: 'full body\n' };
  }

  async append(input: Parameters<KnowledgeConnector['append']>[0]): Promise<Knowledge> {
    this.record('append', input);
    return this.find(input.id);
  }

  private find(id: string): Knowledge {
    return (
      this.items.find((item) => item.id === id) ?? {
        id,
        type: 'knowledge',
        title: 'existing',
        description: null,
        source: 'obsidian',
        external_ref: id.slice('obsidian:'.length),
        area: null,
        tags: [],
      }
    );
  }
}

/** In-memory project connector that records the domain input of every call. */
export class FakeProjectConnector implements ProjectConnector {
  readonly calls: { method: keyof ProjectConnector; arg: unknown }[] = [];
  failWith: Error | undefined;
  projects: ProjectResult[] = [];

  private record(method: keyof ProjectConnector, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.failWith) throw this.failWith;
  }

  async list(filter: Parameters<ProjectConnector['list']>[0]): Promise<ProjectResult[]> {
    this.record('list', filter);
    return this.projects;
  }

  async get(id: string): Promise<ProjectGetResult> {
    this.record('get', id);
    const [owner = '', name = ''] = id.slice('github:'.length).split('/');
    return {
      project: { id, type: 'project', title: name, source: 'github', external_ref: `https://github.com/${owner}/${name}` },
      details: {
        description: null,
        owner,
        default_branch: 'main',
        visibility: 'public',
        archived: false,
        fork: false,
        updated_at: '2026-10-15T13:00:00Z',
      },
    };
  }
}

/** In-memory area connector that records the domain input of every call. */
export class FakeAreaConnector implements AreaConnector {
  readonly calls: { method: keyof AreaConnector; arg: unknown }[] = [];
  failWith: Error | undefined;
  areas: AreaResource[] = [];
  content = '';

  private record(method: keyof AreaConnector, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.failWith) throw this.failWith;
  }

  async list(filter: Parameters<AreaConnector['list']>[0]): Promise<AreaResource[]> {
    this.record('list', filter);
    return this.areas;
  }

  async get(id: string): Promise<AreaGetResult> {
    this.record('get', id);
    const pageId = id.slice('notion:'.length);
    return {
      area: { id, type: 'area', title: 'Area', source: 'notion', external_ref: `https://www.notion.so/${pageId.replaceAll('-', '')}` },
      content: this.content,
    };
  }
}

/** In-memory life log connector that records the domain input of every call. */
export class FakeLifeLogConnector implements LifeLogConnector {
  readonly calls: { method: keyof LifeLogConnector; arg: unknown }[] = [];
  failWith: Error | undefined;
  content = '';

  private record(method: keyof LifeLogConnector, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.failWith) throw this.failWith;
  }

  async create(input: Parameters<LifeLogConnector['create']>[0]): Promise<LifeLog> {
    this.record('create', input);
    return lifelog(`${input.date}-${input.title}.md`);
  }

  async get(id: string): Promise<LifeLogDocument> {
    this.record('get', id);
    return { lifelog: lifelog(id.slice('lifelog:'.length)), content: this.content };
  }

  async append(input: Parameters<LifeLogConnector['append']>[0]): Promise<LifeLog> {
    this.record('append', input);
    return lifelog(input.id.slice('lifelog:'.length));
  }
}

function lifelog(name: string): LifeLog {
  return {
    id: `lifelog:${name}`,
    type: 'lifelog',
    date: name.slice(0, 10),
    title: name.slice(11, -'.md'.length),
    source: 'obsidian',
    external_ref: `AI Foundation/LifeLog/${name}`,
  };
}
