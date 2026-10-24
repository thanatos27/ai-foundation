import { TodoistApi, TodoistRequestError, type Task as TodoistTask } from '@doist/todoist-sdk';
import type { CredentialProvider } from '../../credentials/types.js';
import { CredentialError, FoundationError, NotFoundError, ProviderApiError } from '../../errors.js';

export type { TodoistTask };

/**
 * The part of the Todoist SDK the connector uses. Tests inject a fake. `deleteTask` only rolls
 * back a task the same `create` call has just added; no tool deletes tasks.
 */
export type TodoistClient = Pick<
  TodoistApi,
  'getUser' | 'getTasks' | 'getTask' | 'addTask' | 'updateTask' | 'closeTask' | 'deleteTask'
>;

export type TodoistClientFactory = (apiToken: string) => TodoistClient;

export const createTodoistClient: TodoistClientFactory = (apiToken) => new TodoistApi(apiToken);

/** Creates the SDK client on first use, so the server starts without credentials. */
export function lazyTodoistClient(
  credentials: CredentialProvider,
  factory: TodoistClientFactory = createTodoistClient,
): () => Promise<TodoistClient> {
  let client: Promise<TodoistClient> | undefined;
  return () => {
    client ??= credentials.getTodoistApiToken().then(factory);
    // Retry credential lookup on the next call if it failed (e.g. the token was set later).
    client.catch(() => (client = undefined));
    return client;
  };
}

/**
 * Converts anything thrown by the SDK into a Foundation error. `notFound` names the
 * addressed item for a 404; without it a 404 is a provider error.
 */
export function toFoundationError(error: unknown, notFound?: string): FoundationError {
  if (error instanceof FoundationError) return error;
  if (error instanceof TodoistRequestError) {
    const status = error.httpStatusCode;
    if (error.isAuthenticationError()) {
      return new CredentialError(`Todoist rejected the API token (HTTP ${status})`, { cause: error });
    }
    if (status === 404 && notFound) return new NotFoundError(notFound, { cause: error });
    return new ProviderApiError('Todoist', status ? `HTTP ${status}: ${error.message}` : error.message, {
      cause: error,
    });
  }
  return new ProviderApiError('Todoist', error instanceof Error ? error.message : String(error), { cause: error });
}
