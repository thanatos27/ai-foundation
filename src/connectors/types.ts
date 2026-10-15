import type {
  Area,
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

/** Connectors available to tools. A missing entry means the provider is not wired. */
export interface Connectors {
  task?: TaskConnector;
  schedule?: ScheduleConnector;
  collection?: CollectionConnector;
  knowledge?: KnowledgeConnector;
}
