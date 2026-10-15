import type { GetTasksResponse } from '@doist/todoist-sdk';
import type { Task, TaskCreateInput, TaskListFilter, TaskUpdateInput } from '../../domain/index.js';
import { NotFoundError, ProviderApiError } from '../../errors.js';
import type { TaskConnector } from '../types.js';
import { type TodoistClient, type TodoistTask, toFoundationError } from './client.js';
import { matchesFilter } from './filter.js';
import { CLEAR_DUE, dueArgs, labelsFor, parseTaskId, toTask, updatedLabels } from './mapping.js';

const PAGE_SIZE = 200;

export interface TodoistTaskConnectorOptions {
  /** Resolves the SDK client; called on every operation (memoize it). */
  client: () => Promise<TodoistClient>;
  /** Zone for floating due times and date-granular filters (`defaults.timezone`). */
  timeZone: string;
}

/** Task connector for Todoist. Tasks are created in, and listed from, the Inbox only. */
export class TodoistTaskConnector implements TaskConnector {
  private inboxId: Promise<string> | undefined;

  constructor(private readonly options: TodoistTaskConnectorOptions) {}

  async create(input: TaskCreateInput): Promise<Task> {
    const api = await this.options.client();
    const created = await api
      .addTask({
        content: input.title,
        labels: labelsFor(input),
        ...(input.due != null ? dueArgs(input.due) : {}),
      })
      .catch((error: unknown) => {
        throw toFoundationError(error);
      });
    return this.toTask(created);
  }

  async list(filter: TaskListFilter): Promise<Task[]> {
    const api = await this.options.client();
    const projectId = await this.inboxProjectId(api);
    const tasks: TodoistTask[] = [];
    let cursor: string | null = null;
    do {
      const page: GetTasksResponse = await api.getTasks({ projectId, limit: PAGE_SIZE, cursor }).catch((error: unknown) => {
        throw toFoundationError(error);
      });
      tasks.push(...page.results);
      cursor = page.nextCursor;
    } while (cursor);
    return tasks
      .filter((task) => !task.checked)
      .map((task) => this.toTask(task))
      .filter((task) => matchesFilter(task, filter, this.options.timeZone));
  }

  async update(input: TaskUpdateInput): Promise<Task> {
    const todoistId = parseTaskId(input.id);
    const api = await this.options.client();
    const changesLabels = input.status !== undefined || input.area !== undefined || input.tags !== undefined;
    const current = changesLabels ? await this.getTask(api, input.id, todoistId) : undefined;

    const updated = await api
      .updateTask(todoistId, {
        ...(input.title !== undefined ? { content: input.title } : {}),
        ...(current ? { labels: updatedLabels(current.labels, input) } : {}),
        ...(input.due === null ? CLEAR_DUE : input.due !== undefined ? dueArgs(input.due) : {}),
      })
      .catch((error: unknown) => {
        throw toFoundationError(error, `task ${input.id}`);
      });
    return this.toTask(updated);
  }

  /**
   * Closes the task and returns what Todoist holds afterwards: a recurring task moves to its
   * next occurrence and stays open, anything else is returned as `done`. Only a task that no
   * longer exists after closing falls back to its state before; any other failure to read it
   * back is an error, since its state is then unknown.
   */
  async complete(id: string): Promise<Task> {
    const todoistId = parseTaskId(id);
    const api = await this.options.client();
    const before = await this.getTask(api, id, todoistId);

    await api.closeTask(todoistId).catch((error: unknown) => {
      throw toFoundationError(error, `task ${id}`);
    });

    const after = await this.getTask(api, id, todoistId).catch((error: unknown) => {
      if (error instanceof NotFoundError) return undefined;
      throw new ProviderApiError(
        'Todoist',
        `task ${id} was closed, but its state afterwards could not be read: ${(error as Error).message}`,
        { cause: error },
      );
    });
    if (after && !after.checked) return this.toTask(after);
    return this.toTask(after ?? before, 'done');
  }

  private toTask(task: TodoistTask, status?: Task['status']): Task {
    return toTask(task, this.options.timeZone, status);
  }

  private getTask(api: TodoistClient, id: string, todoistId: string): Promise<TodoistTask> {
    return api.getTask(todoistId).catch((error: unknown) => {
      throw toFoundationError(error, `task ${id}`);
    });
  }

  private inboxProjectId(api: TodoistClient): Promise<string> {
    this.inboxId ??= api.getUser().then(
      (user) => {
        if (!user.inboxProjectId) throw new ProviderApiError('Todoist', 'the Inbox project was not found');
        return user.inboxProjectId;
      },
      (error: unknown) => {
        throw toFoundationError(error);
      },
    );
    this.inboxId.catch(() => (this.inboxId = undefined));
    return this.inboxId;
  }
}
