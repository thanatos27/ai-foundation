import type {
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

/** Connectors available to tools. A missing entry means the provider is not wired. */
export interface Connectors {
  task?: TaskConnector;
  schedule?: ScheduleConnector;
}
