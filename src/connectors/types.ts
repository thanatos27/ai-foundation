import type {
  Schedule,
  ScheduleCreateInput,
  Task,
  TaskCreateInput,
  TaskListFilter,
} from '../domain/index.js';

/**
 * Connector boundary: provider-specific code (auth, API calls, Domain <-> Provider
 * conversion) lives behind these interfaces. Tools depend only on these types.
 *
 * Only operations whose input is defined in spec §9 are declared. The rest
 * (task update/complete, schedule list) and the other entities' connectors are
 * added in the phase that implements them.
 */

/** Source of Truth: Todoist. */
export interface TaskConnector {
  create(input: TaskCreateInput): Promise<Task>;
  list(filter: TaskListFilter): Promise<Task[]>;
}

/** Source of Truth: Google Calendar. */
export interface ScheduleConnector {
  create(input: ScheduleCreateInput): Promise<Schedule>;
}

/** Connectors available to tools. A missing entry means the provider is not wired yet. */
export interface Connectors {
  task?: TaskConnector;
  schedule?: ScheduleConnector;
}
