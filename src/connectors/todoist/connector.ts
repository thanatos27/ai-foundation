import { type GetTasksResponse, TodoistRequestError } from '@doist/todoist-sdk';
import type { Task, TaskCreateInput, TaskListFilter, TaskUpdateInput } from '../../domain/index.js';
import { type FoundationError, InputValidationError, NotFoundError, ProviderApiError } from '../../errors.js';
import type { TaskConnector } from '../types.js';
import { type TodoistClient, type TodoistTask, toFoundationError } from './client.js';
import { matchesFilter } from './filter.js';
import {
  CLEAR_DUE,
  dueArgs,
  dueOf,
  labelsFor,
  parseTaskId,
  recurrenceArgs,
  restoreDueArgs,
  toTask,
  toTaskId,
  updatedLabels,
} from './mapping.js';

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

  /**
   * Adds the task. When Todoist does not read `recurrence` as a recurring rule, the task just
   * added is deleted again, so an error does not leave a task behind (see `rollBackCreated`).
   */
  async create(input: TaskCreateInput): Promise<Task> {
    const { recurrence } = input;
    const api = await this.options.client();
    const created = await api
      .addTask({
        content: input.title,
        labels: labelsFor(input),
        ...(recurrence !== undefined ? recurrenceArgs(recurrence) : input.due != null ? dueArgs(input.due) : {}),
      })
      .catch((error: unknown) => {
        throw recurrence !== undefined ? recurrenceRequestError(error, recurrence) : toFoundationError(error);
      });
    if (recurrence !== undefined && !created.due?.isRecurring) await this.rollBackCreated(api, created, recurrence);
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

  /**
   * Updates the task. Changing the due of a recurring task is rejected before anything is
   * written, since Todoist would drop the recurrence. `recurrence` is always the only change (the
   * input schema enforces it); when Todoist does not read it as recurring, the previous due is
   * put back before failing.
   */
  async update(input: TaskUpdateInput): Promise<Task> {
    const { recurrence } = input;
    const todoistId = parseTaskId(input.id);
    const api = await this.options.client();
    const changesLabels = input.status !== undefined || input.area !== undefined || input.tags !== undefined;
    const needsCurrent = changesLabels || input.due !== undefined || recurrence !== undefined;
    const current = needsCurrent ? await this.getTask(api, input.id, todoistId) : undefined;

    if (input.due !== undefined && current?.due?.isRecurring) {
      throw new InputValidationError(
        `task ${input.id} recurs ("${current.due.string}"); changing its due would remove the recurrence. ` +
          `Change the rule with recurrence, or remove the rule and the due with recurrence: null. Nothing was changed.`,
      );
    }

    if (recurrence !== undefined) {
      const updated = await api
        .updateTask(todoistId, recurrence === null ? CLEAR_DUE : recurrenceArgs(recurrence))
        .catch((error: unknown) => {
          throw recurrence === null
            ? toFoundationError(error, `task ${input.id}`)
            : recurrenceRequestError(error, recurrence, `task ${input.id}`);
        });
      if (recurrence !== null && !updated.due?.isRecurring) {
        await this.restoreDue(api, input.id, current!, updated, recurrence);
      }
      return this.toTask(updated);
    }

    const updated = await api
      .updateTask(todoistId, {
        ...(input.title !== undefined ? { content: input.title } : {}),
        ...(changesLabels && current ? { labels: updatedLabels(current.labels, input) } : {}),
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

  /**
   * Deletes `created`, just added with a rule Todoist read as a one-off due, and throws. Only
   * `true` from deleteTask counts as deleted; `false`, an error or a timeout is checked by reading
   * the task back, and a task that cannot be confirmed gone is reported with its id.
   */
  private async rollBackCreated(api: TodoistClient, created: TodoistTask, rule: string): Promise<never> {
    const notRecurring = `Todoist did not read recurrence "${rule}" as a recurring rule (it was read as ${this.describeDue(created.due)})`;
    const failure = await api.deleteTask(created.id).then(
      (deleted) => (deleted === true ? undefined : new Error('Todoist did not confirm the deletion')),
      (error: unknown) => toFoundationError(error),
    );
    const gone = failure ? await this.isGone(api, created.id) : true;
    if (gone === true) {
      throw new InputValidationError(`${notRecurring}, so no task was created. Use a rule such as "every monday" or "every! 3 days".`);
    }
    throw new ProviderApiError(
      'Todoist',
      `${notRecurring} and task ${toTaskId(created.id)} was created, but deleting it failed: ${failure!.message}. ` +
        `The task ${gone === false ? 'still exists' : 'may still exist'}: fix it with task_update (recurrence) ` +
        `or delete it in Todoist; do not call task_create again.`,
      { cause: failure },
    );
  }

  /** True when the task no longer exists, false when it can be read, undefined when that is unknown. */
  private isGone(api: TodoistClient, todoistId: string): Promise<boolean | undefined> {
    return api.getTask(todoistId).then(
      () => false,
      (error: unknown) => (error instanceof TodoistRequestError && error.httpStatusCode === 404 ? true : undefined),
    );
  }

  /** Puts back `current`'s due after `rule` was read as a one-off due (`updated`), and throws. */
  private async restoreDue(
    api: TodoistClient,
    id: string,
    current: TodoistTask,
    updated: TodoistTask,
    rule: string,
  ): Promise<never> {
    const notRecurring = `Todoist did not read recurrence "${rule}" as a recurring rule`;
    const previous = this.describeDue(current.due);
    const restored = await api
      .updateTask(current.id, restoreDueArgs(current.due, this.options.timeZone))
      .catch((error: unknown) => {
        const cause = toFoundationError(error);
        throw new ProviderApiError(
          'Todoist',
          `${notRecurring} and task ${id} now has ${this.describeDue(updated.due)}; ` +
            `restoring its previous due (${previous}) failed: ${cause.message}`,
          { cause },
        );
      });
    // Setting a rule again makes Todoist compute its next date afresh.
    const recalculated =
      current.due?.isRecurring && restored.due?.date !== current.due.date
        ? ` Its previous rule "${current.due.string}" was set again, and Todoist recalculated the next due ` +
          `(now ${dueOf(restored.due, this.options.timeZone)}).`
        : '';
    throw new InputValidationError(`${notRecurring}; task ${id} was left as before (${previous}).${recalculated}`);
  }

  /** A Todoist due in words, for error messages. */
  private describeDue(due: TodoistTask['due']): string {
    if (!due) return 'no due';
    const next = dueOf(due, this.options.timeZone);
    return due.isRecurring ? `"${due.string}", next ${next}` : `the one-off due ${next}`;
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

/**
 * Error of a request that carried the recurring rule `rule`. Todoist answers a rule it cannot use
 * with a bare HTTP 400, so that is reported as input to check — without claiming the rule is the
 * cause, since a 400 does not say. Everything else goes through toFoundationError.
 */
function recurrenceRequestError(error: unknown, rule: string, notFound?: string): FoundationError {
  if (error instanceof TodoistRequestError && error.httpStatusCode === 400) {
    return new InputValidationError(
      `Todoist rejected the request with recurrence "${rule}" (HTTP 400). ` +
        `Check the rule syntax, e.g. "every monday" or "every! 3 days".`,
      { cause: error },
    );
  }
  return toFoundationError(error, notFound);
}
