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
  NotFoundError,
  ProviderApiError,
} from '../../../src/errors.js';
import { startOfDay } from '../../../src/shared/datetime.js';

const TZ = 'Asia/Tokyo';
const WRITABLE = 'af@group.calendar.google.com';
const EVENTS = 'events@group.calendar.google.com';
const PRIMARY = 'primary@example.com';
const CALENDARS = { personal: WRITABLE, events: EVENTS };

/** An event's [start, end) instants, all-day ones in `TZ`, for the fake's overlap query. */
function instants(event: GoogleEvent): [number, number] | undefined {
  const at = (point: GoogleEvent['start']) =>
    point?.dateTime ? Date.parse(point.dateTime) : point?.date ? startOfDay(point.date, TZ) : undefined;
  const [start, end] = [at(event.start), at(event.end)];
  return start === undefined || end === undefined ? undefined : [start, end];
}

/** Fake Calendar API holding events per calendar and recording every call. */
class FakeCalendarApi implements CalendarApi {
  readonly inserts: { calendarId: string; event: GoogleEvent }[] = [];
  readonly listed: { calendarId: string; range: { timeMin: string; timeMax: string } }[] = [];
  readonly gets: { calendarId: string; eventId: string }[] = [];
  readonly patches: { calendarId: string; eventId: string; patch: GoogleEvent }[] = [];
  calendars: GoogleCalendarListEntry[] = [
    { id: WRITABLE, summary: 'AI Foundation' },
    { id: EVENTS, summary: 'Event Catalog' },
    { id: PRIMARY, summary: 'Primary' },
  ];
  events: Record<string, GoogleEvent[]> = {};
  failInsert: unknown;
  failCalendars: unknown;
  failEvents: Record<string, unknown> = {};
  failGet: unknown;
  failPatch: unknown;

  async insertEvent(calendarId: string, event: GoogleEvent): Promise<GoogleEvent> {
    this.inserts.push({ calendarId, event });
    if (this.failInsert) throw this.failInsert;
    return { ...event, id: `evt${this.inserts.length}`, htmlLink: 'https://calendar.google.com/x' };
  }

  async getEvent(calendarId: string, eventId: string): Promise<GoogleEvent> {
    this.gets.push({ calendarId, eventId });
    if (this.failGet) throw this.failGet;
    const event = this.events[calendarId]?.find((e) => e.id === eventId);
    if (!event) throw googleError(404, 'Not Found');
    return event;
  }

  async patchEvent(calendarId: string, eventId: string, patch: GoogleEvent): Promise<GoogleEvent> {
    this.patches.push({ calendarId, eventId, patch });
    if (this.failPatch) throw this.failPatch;
    const event = this.events[calendarId]!.find((e) => e.id === eventId)!;
    const merged: GoogleEvent = { ...event, ...patch };
    if (patch.start) merged.start = { ...event.start, ...patch.start };
    if (patch.end) merged.end = { ...event.end, ...patch.end };
    for (const key of ['description', 'location'] as const) if (merged[key] === null) delete merged[key];
    return merged;
  }

  async listCalendars(): Promise<GoogleCalendarListEntry[]> {
    if (this.failCalendars) throw this.failCalendars;
    return this.calendars;
  }

  /** Like the API: only events overlapping [timeMin, timeMax) (events without a start pass through). */
  async listEvents(calendarId: string, range: { timeMin: string; timeMax: string }): Promise<GoogleEvent[]> {
    this.listed.push({ calendarId, range });
    if (this.failEvents[calendarId]) throw this.failEvents[calendarId];
    return (this.events[calendarId] ?? []).filter((event) => {
      const span = instants(event);
      return !span || (span[0] < Date.parse(range.timeMax) && span[1] > Date.parse(range.timeMin));
    });
  }
}

/** `null` leaves the writable calendars unconfigured. */
function setup(writableCalendars: Record<string, string> | null = CALENDARS, defaultCalendar = 'personal') {
  const api = new FakeCalendarApi();
  const connector = new GoogleCalendarScheduleConnector({
    api: async () => api,
    writableCalendars: writableCalendars ?? undefined,
    defaultCalendar: writableCalendars ? defaultCalendar : undefined,
    timeZone: TZ,
  });
  return { api, connector };
}

/** Shape of a gaxios error as thrown by the Google client. */
function googleError(status: number, message: string, data?: unknown) {
  return Object.assign(new Error(message), { status, response: { status, data } });
}

const forbidden = (reason: string) => googleError(403, 'Forbidden', { error: { errors: [{ reason }] } });

async function rejection(promise: Promise<unknown>): Promise<FoundationError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FoundationError);
  return error as FoundationError;
}

describe('create', () => {
  it('writes a timed event to the default calendar, one hour by default', async () => {
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
      calendar: 'personal',
      title: '土曜の作業',
      start: '2026-10-17T14:00:00+09:00',
      end: '2026-10-17T15:00:00+09:00',
      description: null,
      location: null,
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

  it('writes an event period to the calendar named by its alias', async () => {
    const { api, connector } = setup();
    const schedule = await connector.create({ title: '展覧会', start: '2026-11-01', end: '2026-11-03', calendar: 'events' });
    expect(api.inserts).toEqual([
      {
        calendarId: EVENTS,
        event: { summary: '展覧会', start: { date: '2026-11-01' }, end: { date: '2026-11-04' } },
      },
    ]);
    expect(schedule).toMatchObject({ calendar: 'events', start: '2026-11-01', end: '2026-11-03' });
  });

  it('stores description and location exactly as given', async () => {
    const { api, connector } = setup();
    const description = '公式: https://example.com/expo\n<b>前売り</b> &amp; 当日\n  ';
    const location = ' 東京都千代田区 ';
    const schedule = await connector.create({ title: 'a', start: '2026-11-01', description, location });
    expect(api.inserts[0]?.event).toMatchObject({ description, location });
    expect(schedule).toMatchObject({ description, location });
  });

  it('sends no description or location when they are null', async () => {
    const { api, connector } = setup();
    const schedule = await connector.create({ title: 'a', start: '2026-11-01', description: null, location: null });
    expect(api.inserts[0]?.event).not.toHaveProperty('description');
    expect(api.inserts[0]?.event).not.toHaveProperty('location');
    expect(schedule).toMatchObject({ description: null, location: null });
  });

  it.each([PRIMARY, WRITABLE, 'unknown'])('never writes to %s given as calendar', async (calendar) => {
    const { api, connector } = setup();
    const error = await rejection(connector.create({ title: 'a', start: '2026-10-19', calendar }));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain('personal, events');
    expect(error.message).not.toContain(EVENTS);
    expect(api.inserts).toEqual([]);
  });

  it('ignores anything else the input carries', async () => {
    const { api, connector } = setup();
    const input = { title: 'a', start: '2026-10-19', calendar_id: PRIMARY };
    await connector.create(input as Parameters<typeof connector.create>[0]);
    expect(api.inserts.map((insert) => insert.calendarId)).toEqual([WRITABLE]);
  });

  it('requires a writable calendar to be configured', async () => {
    const { api, connector } = setup(null);
    const error = await rejection(connector.create({ title: 'a', start: '2026-10-19' }));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toContain('writable_calendars');
    expect(api.inserts).toEqual([]);
  });

  it.each([
    ['missing (404)', googleError(404, 'Not Found'), ConfigurationError, 'was not found'],
    ['not writable (403 requiredAccessLevel)', forbidden('requiredAccessLevel'), ConfigurationError, 'is not writable'],
    ['not writable (403 forbidden)', forbidden('forbidden'), ConfigurationError, 'is not writable'],
    ['missing scope (403 insufficientPermissions)', forbidden('insufficientPermissions'), CredentialError, 'denied'],
  ])('reports a %s calendar', async (_label, thrown, type, text) => {
    const { api, connector } = setup();
    api.failInsert = thrown;
    const error = await rejection(connector.create({ title: 'a', start: '2026-10-19', calendar: 'events' }));
    expect(error).toBeInstanceOf(type);
    expect(error.message).toContain(text);
    if (type === ConfigurationError) expect(error.message).toContain('"events"');
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
      [PRIMARY]: [
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
      { calendarId: EVENTS, range },
      { calendarId: PRIMARY, range },
    ]);
    expect(schedules.map((s) => [s.id, s.calendar, s.start, s.end])).toEqual([
      [`google_calendar:${PRIMARY}:p1`, PRIMARY, '2026-10-15', '2026-10-17'],
      [`google_calendar:${PRIMARY}:p2`, PRIMARY, '2026-10-16T09:00:00+09:00', '2026-10-16T09:30:00+09:00'],
      [`google_calendar:${WRITABLE}:w1`, 'personal', '2026-10-17T14:00:00+09:00', '2026-10-17T15:00:00+09:00'],
    ]);
  });

  it('returns description and location as stored, empty ones as null', async () => {
    const { api, connector } = setup();
    const html = '<p>公式 <a href="https://example.com">サイト</a></p>\n<br>2行目';
    api.events = {
      [WRITABLE]: [
        { id: 'a', summary: 'a', start: { date: '2026-10-12' }, end: { date: '2026-10-13' }, description: html, location: '会場' },
        { id: 'b', summary: 'b', start: { date: '2026-10-12' }, end: { date: '2026-10-13' }, description: '', location: '' },
        { id: 'c', summary: 'c', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } },
      ],
    };
    const schedules = await connector.list({ start: '2026-10-12', end: '2026-10-12' });
    expect(schedules.map((s) => [s.title, s.description, s.location])).toEqual([
      ['a', html, '会場'],
      ['b', null, null],
      ['c', null, null],
    ]);
  });

  it('does not depend on a tag in the description', async () => {
    const { api, connector } = setup();
    api.events = {
      [WRITABLE]: [
        { id: 'a', summary: 'a', start: { date: '2026-10-12' }, end: { date: '2026-10-13' }, description: '#attended' },
        { id: 'b', summary: 'b', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } },
      ],
    };
    const schedules = await connector.list({ start: '2026-10-12', end: '2026-10-12' });
    expect(schedules.map((s) => s.title)).toEqual(['a', 'b']);
  });

  it.each([
    ['an alias', 'events', EVENTS],
    ['a readable calendar ID', PRIMARY, PRIMARY],
    ['a writable calendar ID', WRITABLE, WRITABLE],
  ])('reads only the calendar given by %s', async (_label, calendar, calendarId) => {
    const { api, connector } = setup();
    await connector.list({ start: '2026-10-12', end: '2026-10-18', calendar });
    expect(api.listed).toEqual([
      { calendarId, range: { timeMin: '2026-10-11T15:00:00.000Z', timeMax: '2026-10-18T15:00:00.000Z' } },
    ]);
  });

  it.each([
    ['an unknown alias', 'unknown'],
    ['an unreadable calendar ID', 'other@example.com'],
  ])('rejects %s', async (_label, calendar) => {
    const { api, connector } = setup();
    const error = await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18', calendar }));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain('personal, events');
    expect(api.listed).toEqual([]);
  });

  it('rejects a configured calendar the user can no longer read', async () => {
    const { api, connector } = setup();
    api.calendars = api.calendars.filter((entry) => entry.id !== EVENTS);
    const error = await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18', calendar: 'events' }));
    expect(error).toBeInstanceOf(InputValidationError);
  });

  describe('overlap with an event period (10/30 – 11/05, all-day)', () => {
    const period: GoogleEvent = { id: 'expo', summary: '展覧会', start: { date: '2026-10-30' }, end: { date: '2026-11-06' } };

    it.each([
      ['inside it', '2026-11-01', '2026-11-02'],
      ['ending on its first day', '2026-10-25', '2026-10-30'],
      ['starting on its last day', '2026-11-05', '2026-11-10'],
      ['containing it', '2026-10-01', '2026-12-31'],
      ['a date-time inside its last day', '2026-11-05T23:00:00+09:00', '2026-11-05T23:30:00+09:00'],
    ])('returns it for a period %s', async (_label, start, end) => {
      const { api, connector } = setup();
      api.events = { [EVENTS]: [period] };
      const schedules = await connector.list({ start, end, calendar: 'events' });
      expect(schedules).toEqual([
        {
          id: `google_calendar:${EVENTS}:expo`,
          source: 'google_calendar',
          external_ref: null,
          type: 'schedule',
          calendar: 'events',
          title: '展覧会',
          start: '2026-10-30',
          end: '2026-11-05',
          description: null,
          location: null,
        },
      ]);
    });

    it.each([
      ['before it', '2026-10-20', '2026-10-29'],
      ['after it', '2026-11-06', '2026-11-10'],
    ])('does not return it for a period %s', async (_label, start, end) => {
      const { api, connector } = setup();
      api.events = { [EVENTS]: [period] };
      expect(await connector.list({ start, end })).toEqual([]);
    });
  });

  it('never writes while listing', async () => {
    const { api, connector } = setup();
    await connector.list({ start: '2026-10-12', end: '2026-10-18' });
    expect(api.inserts).toEqual([]);
    expect(api.patches).toEqual([]);
  });

  it('rejects a mixed period that ends before it starts', async () => {
    const { connector } = setup();
    expect(await rejection(connector.list({ start: '2026-10-14', end: '2026-10-13T23:00:00+09:00' }))).toBeInstanceOf(
      InputValidationError,
    );
  });

  it('fails the whole call when one calendar fails, naming it', async () => {
    const { api, connector } = setup();
    api.failEvents[PRIMARY] = googleError(500, 'Backend Error');
    const error = await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18' }));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('Google Calendar API error: calendar "Primary": HTTP 500: Backend Error');
  });

  it('lists without writable calendars', async () => {
    const { api, connector } = setup(null);
    await connector.list({ start: '2026-10-12', end: '2026-10-18' });
    expect(api.listed).toHaveLength(3);
  });
});

describe('update', () => {
  const timed = (): GoogleEvent => ({
    id: 'evt1',
    summary: '打ち合わせ',
    description: 'メモ',
    location: '会議室',
    organizer: { email: WRITABLE, self: true },
    start: { dateTime: '2026-11-10T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-11-10T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
  });
  const allDay = (): GoogleEvent => ({
    id: 'evt2',
    summary: '展覧会',
    organizer: { email: EVENTS },
    start: { date: '2026-11-01' },
    end: { date: '2026-11-04' },
  });
  const id1 = `google_calendar:${WRITABLE}:evt1`;
  const id2 = `google_calendar:${EVENTS}:evt2`;

  function withEvents() {
    const context = setup();
    context.api.events = { [WRITABLE]: [timed()], [EVENTS]: [allDay()], [PRIMARY]: [{ ...timed(), organizer: { email: PRIMARY } }] };
    return context;
  }

  it('sends only the title when only the title changes', async () => {
    const { api, connector } = withEvents();
    const schedule = await connector.update({ id: id1, title: '定例' });
    expect(api.gets).toEqual([{ calendarId: WRITABLE, eventId: 'evt1' }]);
    expect(api.patches).toEqual([{ calendarId: WRITABLE, eventId: 'evt1', patch: { summary: '定例' } }]);
    expect(schedule).toEqual({
      id: id1,
      source: 'google_calendar',
      external_ref: null,
      type: 'schedule',
      calendar: 'personal',
      title: '定例',
      start: '2026-11-10T10:00:00+09:00',
      end: '2026-11-10T11:00:00+09:00',
      description: 'メモ',
      location: '会議室',
    });
  });

  it('sends a new description exactly as given', async () => {
    const { api, connector } = withEvents();
    const description = '新\n<b>本文</b> &amp;\n';
    const schedule = await connector.update({ id: id1, description });
    expect(api.patches[0]?.patch).toEqual({ description });
    expect(schedule.description).toBe(description);
  });

  it('clears description and location with null', async () => {
    const { api, connector } = withEvents();
    const schedule = await connector.update({ id: id1, description: null, location: null });
    expect(api.patches[0]?.patch).toEqual({ description: null, location: null });
    expect(schedule).toMatchObject({ description: null, location: null });
  });

  it('moves a timed event with both end points', async () => {
    const { api, connector } = withEvents();
    await connector.update({ id: id1, start: '2026-11-11T13:00:00+09:00', end: '2026-11-11T14:30:00+09:00' });
    expect(api.patches[0]?.patch).toEqual({
      start: { dateTime: '2026-11-11T13:00:00+09:00' },
      end: { dateTime: '2026-11-11T14:30:00+09:00' },
    });
  });

  it('sends only start when only start changes', async () => {
    const { api, connector } = withEvents();
    const schedule = await connector.update({ id: id1, start: '2026-11-10T09:00:00+09:00' });
    expect(api.patches[0]?.patch).toEqual({ start: { dateTime: '2026-11-10T09:00:00+09:00' } });
    expect(schedule).toMatchObject({ start: '2026-11-10T09:00:00+09:00', end: '2026-11-10T11:00:00+09:00' });
  });

  it('sends only end when only end changes', async () => {
    const { api, connector } = withEvents();
    await connector.update({ id: id1, end: '2026-11-10T12:00:00+09:00' });
    expect(api.patches[0]?.patch).toEqual({ end: { dateTime: '2026-11-10T12:00:00+09:00' } });
  });

  it('extends an event period by its inclusive last day only', async () => {
    const { api, connector } = withEvents();
    const schedule = await connector.update({ id: id2, end: '2026-11-05' });
    expect(api.patches).toEqual([{ calendarId: EVENTS, eventId: 'evt2', patch: { end: { date: '2026-11-06' } } }]);
    expect(schedule).toMatchObject({ calendar: 'events', start: '2026-11-01', end: '2026-11-05' });
  });

  it('moves the first day of an event period only', async () => {
    const { api, connector } = withEvents();
    await connector.update({ id: id2, start: '2026-10-31' });
    expect(api.patches[0]?.patch).toEqual({ start: { date: '2026-10-31' } });
  });

  it('turns a timed event into an all-day one with both end points', async () => {
    const { api, connector } = withEvents();
    const schedule = await connector.update({ id: id1, start: '2026-11-10', end: '2026-11-11' });
    expect(api.patches[0]?.patch).toEqual({
      start: { date: '2026-11-10', dateTime: null },
      end: { date: '2026-11-12', dateTime: null },
    });
    expect(schedule).toMatchObject({ start: '2026-11-10', end: '2026-11-11' });
  });

  it('turns an all-day event into a timed one with both end points', async () => {
    const { api, connector } = withEvents();
    await connector.update({ id: id2, start: '2026-11-01T10:00:00+09:00', end: '2026-11-01T17:00:00+09:00' });
    expect(api.patches[0]?.patch).toEqual({
      start: { dateTime: '2026-11-01T10:00:00+09:00', date: null },
      end: { dateTime: '2026-11-01T17:00:00+09:00', date: null },
    });
  });

  it.each([
    ['start of the other kind', { start: '2026-11-10' }, 'give both start and end'],
    ['end of the other kind', { end: '2026-11-10' }, 'give both start and end'],
    ['start after the end', { start: '2026-11-10T11:30:00+09:00' }, 'give end as well'],
    ['end before the start', { end: '2026-11-10T09:00:00+09:00' }, 'give start as well'],
  ])('rejects only a %s', async (_label, change, text) => {
    const { api, connector } = withEvents();
    const error = await rejection(connector.update({ id: id1, ...change }));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain(text);
    expect(api.patches).toEqual([]);
  });

  it('rejects an all-day end before the first day', async () => {
    const { api, connector } = withEvents();
    expect(await rejection(connector.update({ id: id2, end: '2026-10-31' }))).toBeInstanceOf(InputValidationError);
    expect(api.patches).toEqual([]);
  });

  it('never touches an event on a calendar it does not write to', async () => {
    const { api, connector } = withEvents();
    const error = await rejection(connector.update({ id: `google_calendar:${PRIMARY}:evt1`, title: 'x' }));
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain('does not write to');
    expect(api.gets).toEqual([]);
    expect(api.patches).toEqual([]);
  });

  it.each(['evt1', 'todoist:1', `google_calendar:${WRITABLE}:`, `google_calendar::evt1`, `google_calendar:${WRITABLE}:../x`])(
    'rejects the malformed id %s before any call',
    async (id) => {
      const { api, connector } = withEvents();
      expect(await rejection(connector.update({ id, title: 'x' }))).toBeInstanceOf(InputValidationError);
      expect(api.gets).toEqual([]);
    },
  );

  it('reports a missing event as not found', async () => {
    const { api, connector } = withEvents();
    const error = await rejection(connector.update({ id: `google_calendar:${WRITABLE}:gone`, title: 'x' }));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(api.patches).toEqual([]);
  });

  it('reports a deleted event as not found', async () => {
    const { api, connector } = withEvents();
    api.events[WRITABLE] = [{ ...timed(), status: 'cancelled' }];
    expect(await rejection(connector.update({ id: id1, title: 'x' }))).toBeInstanceOf(NotFoundError);
    expect(api.patches).toEqual([]);
  });

  it.each<[string, GoogleEvent]>([
    ['a recurring series', { recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] }],
    ['a recurring instance', { id: 'evt1', recurringEventId: 'base' }],
    ['an edited recurring instance', { recurringEventId: 'base', originalStartTime: { dateTime: '2026-11-10T10:00:00+09:00' } }],
    ['an out-of-office event', { eventType: 'outOfOffice' }],
    ['a birthday', { eventType: 'birthday' }],
    ['an invitation', { organizer: { email: 'someone@example.com' } }],
  ])('rejects %s without writing', async (_label, fields) => {
    const { api, connector } = withEvents();
    api.events[WRITABLE] = [{ ...timed(), ...fields }];
    expect(await rejection(connector.update({ id: id1, title: 'x' }))).toBeInstanceOf(InputValidationError);
    expect(api.patches).toEqual([]);
  });

  it('updates an event the calendar itself organizes', async () => {
    const { api, connector } = withEvents();
    await connector.update({ id: id2, title: 'x' });
    expect(api.patches).toHaveLength(1);
  });

  it('requires a writable calendar to be configured', async () => {
    const { api, connector } = setup(null);
    expect(await rejection(connector.update({ id: id1, title: 'x' }))).toBeInstanceOf(ConfigurationError);
    expect(api.gets).toEqual([]);
  });

  it.each([
    ['403 requiredAccessLevel', forbidden('requiredAccessLevel'), ConfigurationError],
    ['404', googleError(404, 'Not Found'), NotFoundError],
    ['400 timeRangeEmpty', googleError(400, 'The specified time range is empty.'), ProviderApiError],
  ])('maps a %s from the update', async (_label, thrown, type) => {
    const { api, connector } = withEvents();
    api.failPatch = thrown;
    expect(await rejection(connector.update({ id: id1, start: '2026-11-10T09:00:00+09:00' }))).toBeInstanceOf(type);
  });
});

describe('errors', () => {
  it.each([
    ['invalid_grant', Object.assign(new Error('invalid_grant'), { response: { status: 400, data: { error: 'invalid_grant' } } }), CredentialError],
    ['401', googleError(401, 'Invalid Credentials'), CredentialError],
    ['403 forbidden', forbidden('forbidden'), CredentialError],
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
      writableCalendars: CALENDARS,
      defaultCalendar: 'personal',
      timeZone: TZ,
    });
    const error = await rejection(connector.list({ start: '2026-10-12', end: '2026-10-18' }));
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toContain('GOOGLE_OAUTH_REFRESH_TOKEN');
  });
});
