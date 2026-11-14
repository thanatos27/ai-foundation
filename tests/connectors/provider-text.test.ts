import { TodoistRequestError } from '@doist/todoist-sdk';
import { APIErrorCode } from '@notionhq/client';
import { describe, expect, it } from 'vitest';
import { toFoundationError as googleError } from '../../src/connectors/google-calendar/client.js';
import { toFoundationError as notionError } from '../../src/connectors/notion/client.js';
import { NotionCollectionConnector } from '../../src/connectors/notion/connector.js';
import { toFoundationError as todoistError } from '../../src/connectors/todoist/client.js';
import { TodoistTaskConnector } from '../../src/connectors/todoist/connector.js';
import {
  ConfigurationError,
  CredentialError,
  type FoundationError,
  PROVIDER_TEXT_OMITTED,
  ProviderApiError,
} from '../../src/errors.js';
import { apiError, DATA_SOURCE_ID, FakeNotion } from './notion/fake-client.js';
import { FakeTodoistApi, todoistTask } from './todoist/fake-api.js';

/**
 * Text an SDK or a provider wrote stays in `message` (MCP, unchanged) and is left out of
 * `publicMessage` (HTTP API), while what AI Foundation wrote, such as the id and what to do next,
 * stays in both.
 */
const SECRET = 'SECRET-sdk-text-ghp_0123456789';

function expectSplit(error: FoundationError, kept: string[] = []): void {
  expect(error.message).toContain(SECRET);
  expect(error.publicMessage).not.toContain(SECRET);
  expect(error.publicMessage).toContain(PROVIDER_TEXT_OMITTED);
  for (const text of kept) {
    expect(error.message).toContain(text);
    expect(error.publicMessage).toContain(text);
  }
}

async function rejection(promise: Promise<unknown>): Promise<FoundationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as FoundationError;
}

describe('Google Calendar toFoundationError', () => {
  it.each([
    ['401', { status: 401, message: SECRET }, CredentialError, 'Credential error: Google rejected the credentials (HTTP 401): '],
    [
      '403',
      { status: 403, message: SECRET, response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } } },
      CredentialError,
      'Credential error: Google denied access (HTTP 403): ',
    ],
    ['500', { status: 500, message: SECRET }, ProviderApiError, 'Google Calendar API error: HTTP 500: '],
    ['no status', { message: SECRET }, ProviderApiError, 'Google Calendar API error: '],
  ])('keeps the SDK message out of the public message (%s)', (_label, error, type, publicMessage) => {
    const converted = googleError(error);
    expect(converted).toBeInstanceOf(type);
    expectSplit(converted);
    expect(converted.message).toBe(`${publicMessage}${SECRET}`);
    expect(converted.publicMessage).toBe(`${publicMessage}${PROVIDER_TEXT_OMITTED}`);
  });

  it('keeps the context written by AI Foundation', () => {
    const converted = googleError({ status: 500, message: SECRET }, { context: 'calendar "家族"' });
    expect(converted.publicMessage).toBe(`Google Calendar API error: calendar "家族": HTTP 500: ${PROVIDER_TEXT_OMITTED}`);
  });
});

describe('Notion toFoundationError', () => {
  it('keeps the message of a missing capability out of the public message', () => {
    const converted = notionError(apiError(403, APIErrorCode.RestrictedResource, SECRET));
    expect(converted).toBeInstanceOf(ConfigurationError);
    expectSplit(converted, ['lacks a required capability', '(HTTP 403)']);
  });

  it('keeps the status and the error code, not the message', () => {
    const converted = notionError(apiError(503, APIErrorCode.ServiceUnavailable, SECRET));
    expect(converted.message).toBe(`Notion API error: HTTP 503 service_unavailable: ${SECRET}`);
    expect(converted.publicMessage).toBe(`Notion API error: HTTP 503 service_unavailable: ${PROVIDER_TEXT_OMITTED}`);
  });

  it('keeps the message of any other error out of the public message', () => {
    const converted = notionError(new TypeError(SECRET));
    expect(converted.publicMessage).toBe(`Notion API error: ${PROVIDER_TEXT_OMITTED}`);
    expectSplit(converted);
  });
});

describe('Todoist toFoundationError', () => {
  it.each([
    ['an HTTP error', new TodoistRequestError(SECRET, 503), `Todoist API error: HTTP 503: ${PROVIDER_TEXT_OMITTED}`],
    ['a network error', new TodoistRequestError(SECRET), `Todoist API error: ${PROVIDER_TEXT_OMITTED}`],
    ['any other error', new Error(SECRET), `Todoist API error: ${PROVIDER_TEXT_OMITTED}`],
  ])('keeps the SDK message out of the public message (%s)', (_label, error, publicMessage) => {
    const converted = todoistError(error);
    expectSplit(converted);
    expect(converted.publicMessage).toBe(publicMessage);
  });
});

describe('TodoistTaskConnector results reported with a provider error', () => {
  const TZ = 'Asia/Tokyo';
  const setup = (tasks = [todoistTask({ id: 't1' })]) => {
    const api = new FakeTodoistApi(tasks);
    return { api, connector: new TodoistTaskConnector({ client: async () => api, timeZone: TZ }) };
  };

  it('says a completed task was closed when reading it back fails', async () => {
    const { api, connector } = setup();
    const close = api.closeTask.bind(api);
    api.closeTask = async (...args) => {
      const result = await close(...args);
      api.failures.getTask = new TodoistRequestError(SECRET, 503);
      return result;
    };
    const error = await rejection(connector.complete('todoist:t1'));
    expect(error).toBeInstanceOf(ProviderApiError);
    expectSplit(error, ['task todoist:t1 was closed, but its state afterwards could not be read']);
  });

  it('says a created task may still exist when rolling it back fails', async () => {
    const { api, connector } = setup([]);
    api.failures.deleteTask = new TodoistRequestError(SECRET);
    api.failures.getTask = new TodoistRequestError('fetch failed');
    const error = await rejection(connector.create({ title: 'a', recurrence: 'tomorrow' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expectSplit(error, [
      'task todoist:100 was created, but deleting it failed',
      'The task may still exist',
      'do not call task_create again',
    ]);
  });

  it('keeps AI Foundation text from a rollback that Todoist did not confirm', async () => {
    const { api, connector } = setup([]);
    api.deleteResult = false;
    const error = await rejection(connector.create({ title: 'a', recurrence: 'tomorrow' }));
    expect(error.publicMessage).toBe(error.message);
    expect(error.publicMessage).toContain('deleting it failed: Todoist did not confirm the deletion');
  });

  it('says what the task now has when restoring its due fails', async () => {
    const due = { isRecurring: true, string: 'every day', date: '2026-10-19', timezone: null, lang: 'en' };
    const { api, connector } = setup([todoistTask({ id: 'r1', due })]);
    const update = api.updateTask.bind(api);
    let count = 0;
    api.updateTask = async (...args) => {
      count += 1;
      if (count === 2) api.failures.updateTask = new TodoistRequestError(SECRET, 503);
      return update(...args);
    };
    const error = await rejection(connector.update({ id: 'todoist:r1', recurrence: 'tomorrow' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expectSplit(error, ['task todoist:r1 now has', 'restoring its previous due']);
  });
});

describe('NotionCollectionConnector results reported with a provider error', () => {
  it('says the properties were updated when appending the note fails', async () => {
    const fake = new FakeNotion();
    const connector = new NotionCollectionConnector({
      client: async () => fake.client,
      dataSourceId: DATA_SOURCE_ID,
      warn: () => undefined,
    });
    const { id } = await connector.create({ title: 'a', collection_type: 'game', status: 'playing' });
    fake.failNext('blocks.children.append', apiError(503, APIErrorCode.ServiceUnavailable, SECRET));
    const error = await rejection(connector.update({ id: id!, status: 'completed', append_note: 'メモ' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expectSplit(error, [`the properties of collection item ${id} were updated, but the note could not be appended`]);
  });
});
