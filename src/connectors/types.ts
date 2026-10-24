import type {
  Area,
  AreaGetResult,
  AreaListFilter,
  AreaResource,
  CollectionCreateInput,
  CollectionItem,
  CollectionSearchFilter,
  CollectionUpdateInput,
  Knowledge,
  KnowledgeAppendInput,
  KnowledgeCreateInput,
  KnowledgeDocument,
  KnowledgeSearchFilter,
  KnowledgeSearchResult,
  LifeLog,
  LifeLogAppendInput,
  LifeLogCreateInput,
  LifeLogDocument,
  ProjectGetResult,
  ProjectListFilter,
  ProjectResult,
  Schedule,
  ScheduleCreateInput,
  ScheduleListFilter,
  Task,
  TaskCreateInput,
  TaskListFilter,
  TaskUpdateInput,
} from '../domain/index.js';

/**
 * Connector boundary: provider-specific code (auth, API calls, Domain <-> Provider
 * conversion) lives behind these interfaces. Tools depend only on these types.
 *
 * Methods throw the errors in `src/errors.ts`. The other entities' connectors are
 * added in the phase that implements them.
 */

/** Source of Truth: Todoist. */
export interface TaskConnector {
  create(input: TaskCreateInput): Promise<Task>;
  /** Open tasks in the Inbox that match `filter`. */
  list(filter: TaskListFilter): Promise<Task[]>;
  update(input: TaskUpdateInput): Promise<Task>;
  /** Completes the task and returns its state afterwards (a recurring task stays open). */
  complete(id: string): Promise<Task>;
}

/** Source of Truth: Google Calendar. */
export interface ScheduleConnector {
  /** Creates the event on the configured writable calendar only. */
  create(input: ScheduleCreateInput): Promise<Schedule>;
  /** Events overlapping the period on every calendar the user can read. */
  list(filter: ScheduleListFilter): Promise<Schedule[]>;
}

/** Source of Truth: Notion. Reads and writes only the configured collection data source. */
export interface CollectionConnector {
  /** Creates the item, with `note` as the first paragraph of its page. */
  create(input: CollectionCreateInput): Promise<CollectionItem>;
  /** Items matching every given filter, by properties only (page content is not searched). */
  search(filter: CollectionSearchFilter): Promise<CollectionItem[]>;
  /** Updates the item with this exact ID and returns its state afterwards. */
  update(input: CollectionUpdateInput): Promise<CollectionItem>;
}

/** `knowledge_create` input once the tool has resolved the source and the default area. */
export type KnowledgeCreate = Omit<KnowledgeCreateInput, 'source' | 'area'> & { area: Area | null };

/** Source of Truth: Obsidian. Reads and writes only Markdown files under the configured knowledge_dir. */
export interface KnowledgeConnector {
  /** Creates a new note directly under knowledge_dir. Never overwrites an existing file. */
  create(input: KnowledgeCreate): Promise<Knowledge>;
  /** Knowledge under knowledge_dir (recursively) matching every given filter; malformed notes are skipped. */
  search(filter: KnowledgeSearchFilter): Promise<KnowledgeSearchResult[]>;
  /** Metadata and the full body of the knowledge with this exact ID. */
  get(id: string): Promise<KnowledgeDocument>;
  /** Appends to the end of the body without touching the frontmatter; returns the metadata. */
  append(input: KnowledgeAppendInput): Promise<Knowledge>;
}

/** Source of Truth: GitHub. Read-only: projects are discovered from the provider on every call. */
export interface ProjectConnector {
  /** Every project the credential can access that matches `filter`, sorted by canonical owner/repository. */
  list(filter: ProjectListFilter): Promise<ProjectResult[]>;
  /**
   * The project with this exact id and its provider details, as the provider currently resolves it.
   * Only projects that `list` can return are available (the same access boundary); others are not found.
   */
  get(id: string): Promise<ProjectGetResult>;
}

/**
 * Source of Truth: Notion. Read-only: the areas are the child pages directly under the configured
 * parent page, discovered from Notion on every call.
 */
export interface AreaConnector {
  /** Every area matching `filter`, sorted by title (ignoring case), then id. */
  list(filter: AreaListFilter): Promise<AreaResource[]>;
  /**
   * The area with this exact id and its table of contents. Only areas that `list` can return are
   * available (the same boundary); others are not found. Linked pages are never fetched.
   */
  get(id: string): Promise<AreaGetResult>;
}

/**
 * Source of Truth: Obsidian. Reads and writes only the Markdown files directly in the configured
 * life log directory. Articles are never listed, renamed or deleted.
 */
export interface LifeLogConnector {
  /** Creates a new article named after its date and title. Never overwrites an existing file. */
  create(input: LifeLogCreateInput): Promise<LifeLog>;
  /** The article with this exact id and its full Markdown text. */
  get(id: string): Promise<LifeLogDocument>;
  /** Appends `content` as a new paragraph at the end without changing the existing text. */
  append(input: LifeLogAppendInput): Promise<LifeLog>;
}

/** Connectors available to tools. A missing entry means the provider is not wired. */
export interface Connectors {
  task?: TaskConnector;
  schedule?: ScheduleConnector;
  collection?: CollectionConnector;
  knowledge?: KnowledgeConnector;
  project?: ProjectConnector;
  area?: AreaConnector;
  lifelog?: LifeLogConnector;
}
