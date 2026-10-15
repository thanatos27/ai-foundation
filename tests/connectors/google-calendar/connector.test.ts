import { describe, expect, it, vi } from 'vitest';
import {
  type CalendarApi,
  type GoogleCalendarListEntry,
  type GoogleEvent,
  lazyCalendarApi,
} from '../../../src/connectors/google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from '../../../src/connectors/google-calendar/connector.js';
import { EnvCredentialProvider } from '../../../src/credentials/env.js';
import {
  ConfigurationError,
  CredentialError,
  FoundationError,
  InputValidationError,
  ProviderApiError,
} from '../../../src/errors.js';

const TZ = 'Asia/Tokyo';
const WRITABLE = 'af@group.calendar.google.com';

/** Fake Calendar API holding events per calendar and recording every call. */
class FakeCalendarApi implements CalendarApi {
  readonly inserts: { calendarId: string; event: GoogleEvent }[] = [];
  readonly listed: { calendarId: string; range: { timeMin: string; timeMax: string } }[] = [];
  calendars: GoogleCalendarListEntry[] = [
    { id: WRITABLE, summary: 'AI Foundation' },
    { id: 'primary@example.com', summary: 'Primary' },
  ];
  events: Record<string, GoogleEvent[]> = {};
  failInsert: unknown;
  failCalendars: unknown;
  failEvents: Record<string, unknown> = {};

  async insertEvent(calendarId: string, event: GoogleEvent): Promise<GoogleEvent> {
    this.inserts.push({ calendarId, event });
    if (this.failInsert) throw this.failInsert;
    return { ...event, id: `evt${this.inserts.length}`, htmlLink: 'https://calendar.google.com/x' };
  }

  async listCalendars(): Promise<GoogleCalendarListEntry[]> {
    if (this.failCalendars) throw this.failCalendars;
    return this.calendars;
  }

  async listEvents(calendarId: string, range: { timeMin: string; timeMax: string }): Promise<GoogleEvent[]> {
    this.listed.push({ calendarId, range });
    if (this.failEvents[calendarId]) throw this.failEvents[calendarId];
    return this.events[calendarId] ?? [];
  }
}

/** `null` leaves the writable calendar unconfigured. */
function setup(writableCalendarId: string | null = WRITABLE) {
  const api = new FakeCalendarApi();
  const connector = new GoogleCalendarScheduleConnector({
    api: async () => api,
    writableCalendarId: writableCalendarId ?? undefined,
    timeZone: TZ,
  });
  return { api, connector };
}

/** Shape of a gaxios error as thrown by the Google client. */
function googleError(status: number, message: string, data?: unknown) {
  return Object.assign(new Error(message), { status, response: { status, data } });
}

async function rejection(promise: Promise<unknown>): Promise<FoundationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FoundationError);
  return error as FoundationError;
}

describe('create', () => {
  it('writes a timed event to the writable calendar, one hour by default', async () => {
    const { api, connector } = setup();
    const schedule = await connector.create({ title: '土曜の作業', start: '2026-10-17T14:00:00+09:00' });

    expect(api.inserts).toEqual([
      {
        calendarId: WRITABLE,
        event: {
          summary: '土曜の作業',
          start: { dateTime: '2026-10-17T14:00:00+09:00' },
          end: { dateTime: '2026-10-17T15:00:00+09:00' },
        },
      },
    ]);
    expect(schedule).toEqual({
      id: `google_calendar:${WRITABLE}:evt1`,
      source: 'google_calendar',
      external_ref: 'https://calendar.google.com/x',
      type: 'schedule',
      title: '土曜の作業',
      start: '2026-10-17T14:00:00+09:00',
      end: '2026-10-17T15:00:00+09:00',
    });
  });

  it('keeps a non-default offset and sends no timeZone', async () => {
    const { api, connector } = setup();
    await connector.create({ title: 'a', start: '2026-10-14T20:00:00+02:00' });
    const { event } = api.inserts[0]!;
    expect(event.start).toEqual({ dateTime: '2026-10-14T20:00:00+02:00' });
    expect(event.end).toEqual({ dateTime: '2026-10-14T21:00:00+02:00' });
  });

  it('creates a single all-day event', async () => {
    const { api, connector } = setup();
    const schedule = await connector.create({ title: '休み', start: '2026-10-19' });
    expect(api.inserts[0]?.event).toMatchObject({ start: { date: '2026-10-19' }, end: { date: '2026-10-20' } });
    expect(schedule).toMatchObject({ start: '2026-10-19', end: '2026-10-19' });
  });

  it('creates a multi-day all-day event with an inclusive end', async () => {
    const { api, connector } = setup();
    const schedule = await connector.create({ title: '出張', start: '2026-10-19', end: '2026-10-21' });
    expect(api.inserts[0]?.event).toMatchObject({ start: { date: '2026-10-19' }, end: { date: '2026-10-22' } });
    expect(schedule).toMatchObject({ start: '2026-10-19', end: '2026-10-21' });
  });

  it('always writes to the writable calendar, whatever the input carries', async () => {
    const { api, connector } = setup();
    const input = { title: 'a', start: '2026-10-19', calendar_id: 'primary@example.com' };
    await connector.create(input as Parameters<typeof connector.create>[0]);
    expect(api.inserts.map((insert) => insert.calendarId)).toEqual([WRITABLE]);
  });

  it('requires the writable calendar to be configured', async () => {
    const { api, connector } = setup(null);
    const error = await rejection(connector.create({ title: 'a', start: '2026-10-19' }));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toContain('writable_calendar_id');
    expect(api.inserts).toEqual([]);
  });

  it('reports a missing writable calendar as a configuration error', async () => {
    const { api, connector } = setup();
    api.failInsert = googleError(404, 'Not Found');
    const error = await rejection(connector.create({ title: 'a', start: '2026-10-19' }));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toContain(WRITABLE);
  });
});

describe('list', () => {
  it('reads every calendar for the period and merges by start', async () => {
    const { api, connector } = setup();
    api.events = {
      [WRITABLE]: [
        {
          id: 'w1',
          summary: '作業',
          start: { dateTime: '2026-10-17T14:00:00+09:00' },
          end: { dateTime: '2026-10-17T15:00:00+09:00' },
        },
        { id: 'w2', summary: 'cancelled', status: 'cancelled', start: { date: '2026-10-17' }, end: { date: '2026-10-18' } },
      ],
      'primary@example.com': [
        { id: 'p1', summary: '出張', start: { date: '2026-10-15' }, end: { date: '2026-10-18' } },
        {
          id: 'p2',
          summary: '朝会',
          start: { dateTime: '2026-10-16T09:00:00+09:00' },
          end: { dateTime: '2026-10-16T09:30:00+09:00' },
        },
      ],
    };

    const schedules = await connector.list({ start: '2026-10-12', end: '2026-10-18' });

    const range = { timeMin: '2026-10-11T15:00:00.000Z', timeMax: '2026-10-18T15:00:00.000Z' };
    expect(api.listed).toEqual([
      { calendarId: WRITABLE, range },
      { calendarId: 'primary@example.com', range },
    ]);
    expect(schedules.map((s) => [s.id, s.start, s.end])).toEqual([
      ['google_calendar:primary@example.com:p1', '2026-10-15', '2026-10-17'],
      ['google_calendar:primary@example.com:p2', '2026-10-16T09:00:00+09:00', '2026-10-16T09:30:00+09:00'],
      [`google_calendar:${WRITABLE}:w1`, '2026-10-17T14:00:00+09:00', '2026-10-17T15:00:00+09:00'],
    ]);
  });

  it('never writes while listing', async () => {
    const { api, connector } = setup();
    await connector.list({ start: '2026-10-12', end: '2026-10-18' });
    expect(api.inserts).toEqual([]);
  });

  it('rejects a mixed period that ends before it starts', async () => {
    const { connector } = setup();
    expect(await rejection(connector.list({ start: '2026-10-14', end: '2026-10-13T23:00:00+09:00' }))).toBeInstanceOf(
      InputValidationError,
    );
  });

  it('fails the whole call when one calendar fails, naming it', async () => {
    const { api, connector } = setup();
    api.failEvents['primary@example.com'] = googleError(500, 'Backend Error');
    const error = await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('Google Calendar API error: calendar "Primary": HTTP 500: Backend Error');
  });
});

describe('errors', () => {
  it.each([
    ['invalid_grant', Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } }), CredentialError],
    ['401', googleError(401, 'Invalid Credentials'), CredentialError],
    ['403 forbidden', googleError(403, 'Forbidden', { error: { errors: [{ reason: 'forbidden' }] } }), CredentialError],
    ['403 rate limit', googleError(403, 'Rate Limit Exceeded', { error: { errors: [{ reason: 'rateLimitExceeded' }] } }), ProviderApiError],
    ['429', googleError(429, 'Too Many Requests'), ProviderApiError],
    ['500', googleError(500, 'Backend Error'), ProviderApiError],
    ['network', new Error('getaddrinfo ENOTFOUND www.googleapis.com'), ProviderApiError],
  ])('maps %s', async (_label, thrown, type) => {
    const { api, connector } = setup();
    api.failCalendars = thrown;
    expect(await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18' }))).toBeInstanceOf(type);
  });

  it('tells the user how to recover from an expired refresh token', async () => {
    const { api, connector } = setup();
    api.failCalendars = Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } });
    const error = await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18' }));
    expect(error.message).toContain('npm run auth:google');
  });
});

describe('lazyCalendarApi', () => {
  const env = {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh-token',
  };

  it('creates the client once from the credential provider', async () => {
    const factory = vi.fn(() => new FakeCalendarApi());
    const api = lazyCalendarApi(new EnvCredentialProvider(env), factory);
    await api();
    await api();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ clientId: 'client-id', clientSecret: 'client-secret', refreshToken: 'refresh-token' });
  });

  it('reports missing credentials when the connector is used', async () => {
    const connector = new GoogleCalendarScheduleConnector({
      api: lazyCalendarApi(new EnvCredentialProvider({}), () => new FakeCalendarApi()),
      writableCalendarId: WRITABLE,
      timeZone: TZ,
    });
    const error = await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18' }));
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toContain('GOOGLE_OAUTH_REFRESH_TOKEN');
  });
});
