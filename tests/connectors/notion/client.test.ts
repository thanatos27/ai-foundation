import { APIErrorCode, RequestTimeoutError, UnknownHTTPResponseError } from '@notionhq/client';
import { describe, expect, it, vi } from 'vitest';
import {
  createNotionClient,
  lazyNotionClient,
  NOTION_API_VERSION,
  type NotionClient,
  toFoundationError,
} from '../../../src/connectors/notion/client.js';
import type { CredentialProvider } from '../../../src/credentials/types.js';
import { EnvCredentialProvider } from '../../../src/credentials/env.js';
import {
  ConfigurationError,
  CredentialError,
  NotFoundError,
  ProviderApiError,
} from '../../../src/errors.js';
import { apiError } from './fake-client.js';

const TOKEN = 'ntn_super_secret_token';

describe('lazyNotionClient', () => {
  it('creates the client once, from the credential provider token', async () => {
    const client = {} as NotionClient;
    const factory = vi.fn(() => client);
    const get = lazyNotionClient(new EnvCredentialProvider({ NOTION_API_TOKEN: TOKEN }), factory);

    expect(factory).not.toHaveBeenCalled();
    await expect(get()).resolves.toBe(client);
    await expect(get()).resolves.toBe(client);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(TOKEN);
  });

  it('retries the credential lookup after a failure', async () => {
    const env: Record<string, string> = {};
    const factory = vi.fn(() => ({}) as NotionClient);
    const get = lazyNotionClient(new EnvCredentialProvider(env), factory);

    await expect(get()).rejects.toThrow('Credential error: Notion credential is not configured: set NOTION_API_TOKEN');
    env.NOTION_API_TOKEN = TOKEN;
    await expect(get()).resolves.toBeDefined();
  });

  it('never reads the environment itself', async () => {
    vi.stubEnv('NOTION_API_TOKEN', TOKEN);
    const credentials: CredentialProvider = new EnvCredentialProvider({});
    await expect(lazyNotionClient(credentials, () => ({}) as NotionClient)()).rejects.toBeInstanceOf(CredentialError);
    vi.unstubAllEnvs();
  });
});

describe('createNotionClient', () => {
  it('sends the pinned API version and the token', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ object: 'data_source', id: 'x', properties: {} })));
    vi.stubGlobal('fetch', fetch);
    try {
      await createNotionClient(TOKEN).dataSources.retrieve({ data_source_id: '11111111-2222-3333-4444-555555555555' });
    } finally {
      vi.unstubAllGlobals();
    }
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Notion-Version']).toBe(NOTION_API_VERSION);
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(NOTION_API_VERSION).toBe('2026-03-11');
  });
});

describe('toFoundationError', () => {
  const notFound = () => new NotFoundError('collection item notion:x');

  it.each([
    [apiError(401, APIErrorCode.Unauthorized), CredentialError, 'Credential error: Notion rejected the API token (HTTP 401)'],
    [apiError(403, APIErrorCode.RestrictedResource, 'Insufficient permissions'), ConfigurationError, 'lacks a required capability'],
    [apiError(404, APIErrorCode.ObjectNotFound), NotFoundError, 'Not found: collection item notion:x'],
    [apiError(400, APIErrorCode.ValidationError, 'body failed validation'), ProviderApiError, 'Notion API error: HTTP 400 validation_error: body failed validation'],
    [apiError(409, APIErrorCode.ConflictError), ProviderApiError, 'HTTP 409 conflict_error'],
    [apiError(429, APIErrorCode.RateLimited), ProviderApiError, 'HTTP 429 rate_limited'],
    [apiError(500, APIErrorCode.InternalServerError), ProviderApiError, 'HTTP 500 internal_server_error'],
    [new RequestTimeoutError(), ProviderApiError, 'Notion API error: Request to Notion API has timed out'],
    [
      new UnknownHTTPResponseError({ status: 502, message: undefined, headers: {}, rawBodyText: 'Bad Gateway' }),
      ProviderApiError,
      'HTTP 502',
    ],
    [new TypeError('fetch failed'), ProviderApiError, 'Notion API error: fetch failed'],
  ])('maps %s', (error, type, message) => {
    const converted = toFoundationError(error, { notFound });
    expect(converted).toBeInstanceOf(type);
    expect(converted.message).toContain(message);
    // A 404 becomes whatever `notFound` builds; the connector attaches the cause there.
    if (type !== NotFoundError) expect(converted.cause).toBe(error);
    expect(converted.message).not.toContain(TOKEN);
  });

  it('treats a 404 without a notFound handler as a provider error', () => {
    expect(toFoundationError(apiError(404, APIErrorCode.ObjectNotFound))).toBeInstanceOf(ProviderApiError);
  });

  it('keeps Foundation errors as they are', () => {
    const error = new ConfigurationError('x');
    expect(toFoundationError(error)).toBe(error);
  });
});
