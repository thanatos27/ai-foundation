import {
  APIErrorCode,
  Client,
  isHTTPResponseError,
  isNotionClientError,
  LogLevel,
  type Logger,
} from '@notionhq/client';
import type { CredentialProvider } from '../../credentials/types.js';
import { ConfigurationError, CredentialError, FoundationError, ProviderApiError } from '../../errors.js';

/**
 * Notion API version sent with every request. Pinned here rather than taken from the SDK default,
 * so an SDK upgrade cannot change API behaviour (e.g. `in_trash` and block `position` need 2026-03-11).
 */
export const NOTION_API_VERSION = '2026-03-11';

/** The part of the Notion SDK the connector uses. Tests inject a fake. */
export interface NotionClient {
  dataSources: Pick<Client['dataSources'], 'retrieve' | 'query'>;
  pages: Pick<Client['pages'], 'create' | 'retrieve' | 'update'>;
  blocks: { children: Pick<Client['blocks']['children'], 'append' | 'list'> };
}

export type NotionClientFactory = (apiToken: string) => NotionClient;

/** stdout carries MCP JSON-RPC only, so SDK logs go to stderr. */
const stderrLogger: Logger = (level, message, extraInfo) => {
  console.error(`[ai-foundation] Notion ${level}: ${message}`, extraInfo);
};

export const createNotionClient: NotionClientFactory = (auth) =>
  new Client({
    auth,
    notionVersion: NOTION_API_VERSION,
    logLevel: LogLevel.WARN,
    logger: stderrLogger,
    // The SDK retries 429 / 529 (and 500 / 503 for GET). Cap the wait so a tool call does not hang.
    retry: { maxRetries: 2, maxRetryDelayMs: 10_000 },
  });

/** Creates the SDK client on first use, so the server starts without credentials. */
export function lazyNotionClient(
  credentials: CredentialProvider,
  factory: NotionClientFactory = createNotionClient,
): () => Promise<NotionClient> {
  let client: Promise<NotionClient> | undefined;
  return () => {
    client ??= credentials.getNotionApiToken().then(factory);
    // Retry credential lookup on the next call if it failed (e.g. the token was set later).
    client.catch(() => (client = undefined));
    return client;
  };
}

/**
 * Converts anything thrown by the SDK into a Foundation error. `notFound` supplies the error for a
 * 404, which means different things for the data source (configuration) and for a page (not found).
 * Messages carry Notion's error code and message only, never the token or request headers.
 */
export function toFoundationError(
  error: unknown,
  { notFound }: { notFound?: () => FoundationError } = {},
): FoundationError {
  if (error instanceof FoundationError) return error;
  const options = { cause: error };
  if (isNotionClientError(error) && isHTTPResponseError(error)) {
    const { code, status, message } = error;
    if (code === APIErrorCode.Unauthorized) {
      return new CredentialError(`Notion rejected the API token (HTTP ${status})`, options);
    }
    if (code === APIErrorCode.RestrictedResource) {
      return new ConfigurationError(
        `the Notion connection lacks a required capability (read, update and insert content) (HTTP ${status}): ${message}`,
        options,
      );
    }
    if (code === APIErrorCode.ObjectNotFound && notFound) return notFound();
    return new ProviderApiError('Notion', `HTTP ${status} ${code}: ${message}`, options);
  }
  return new ProviderApiError('Notion', error instanceof Error ? error.message : String(error), options);
}
