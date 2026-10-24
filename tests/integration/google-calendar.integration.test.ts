import { type calendar_v3, calendar } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyCalendarApi } from '../../src/connectors/google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from '../../src/connectors/google-calendar/connector.js';
import { parseScheduleId } from '../../src/connectors/google-calendar/mapping.js';
import { InputValidationError } from '../../src/errors.js';
import { addDays } from '../../src/shared/datetime.js';
import { credentials, daysFromToday, enabled, hasEnv, integrationConfig, runLabel } from './setup.js';

const run = enabled && hasEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN');

describe.runIf(run)('Google Calendar (real API)', () => {
  let connector: GoogleCalendarScheduleConnector;
  let writableCalendars: Record<string, string>;
  let defaultAlias: string;
  let defaultCalendarId: string;
  let timeZone: string;
  /** Direct googleapis client, independent of the code under test (expectations and cleanup). */
  let raw: calendar_v3.Calendar;
  const created: { calendarId: string; eventId: string }[] = [];
  const day = daysFromToday(30);

  beforeAll(async () => {
    const config = await integrationConfig();
    const { writable_calendars: calendars, default_calendar: alias } = config.sources.schedule;
    if (!calendars || !alias) {
      throw new Error('Set sources.schedule.writable_calendars and default_calendar (e.g. in config.local.yaml)');
    }
    writableCalendars = calendars;
    defaultAlias = alias;
    defaultCalendarId = calendars[alias]!;
    timeZone = config.defaults.timezone;
    connector = new GoogleCalendarScheduleConnector({
      api: lazyCalendarApi(credentials),
      writableCalendars,
      defaultCalendar: defaultAlias,
      timeZone,
    });

    const { clientId, clientSecret, refreshToken } = await credentials.getGoogleOAuthCredentials();
    const auth = new OAuth2Client({ clientId, clientSecret });
    auth.setCredentials({ refresh_token: refreshToken });
    raw = calendar({ version: 'v3', auth });
  });

  afterAll(async () => {
    // The connector itself never deletes.
    await Promise.allSettled(created.map(({ calendarId, eventId }) => raw.events.delete({ calendarId, eventId })));
  });

  const remember = (id: string | undefined) => {
    const parsed = parseScheduleId(id!);
    created.push(parsed);
    return parsed;
  };
  const rawEvent = async (id: string | undefined) => {
    const { calendarId, eventId } = parseScheduleId(id!);
    return (await raw.events.get({ calendarId, eventId })).data;
  };

  it('creates timed and all-day events on the default calendar and lists them', async () => {
    const timed = await connector.create({ title: `${runLabel} timed`, start: `${day}T14:00:00+09:00` });
    remember(timed.id);
    expect(timed.id).toContain(defaultCalendarId);
    expect(timed.calendar).toBe(defaultAlias);
    expect(Date.parse(timed.end!) - Date.parse(timed.start)).toBe(3_600_000);

    const single = await connector.create({ title: `${runLabel} all-day`, start: day });
    remember(single.id);
    expect(single).toMatchObject({ start: day, end: day });

    const multiEnd = addDays(day, 2);
    const multi = await connector.create({ title: `${runLabel} multi-day`, start: day, end: multiEnd });
    remember(multi.id);
    expect(multi).toMatchObject({ start: day, end: multiEnd });

    const listed = await connector.list({ start: day, end: day });
    const ours = listed.filter((s) => s.title.startsWith(runLabel));
    expect(ours.map((s) => [s.title, s.calendar, s.start, s.end, s.description, s.location]).sort()).toEqual(
      [
        [`${runLabel} all-day`, defaultAlias, day, day, null, null],
        [`${runLabel} multi-day`, defaultAlias, day, multiEnd, null, null],
        [`${runLabel} timed`, defaultAlias, timed.start, timed.end, null, null],
      ].sort(),
    );
  });

  it('stores description and location exactly as given', async () => {
    const description = `公式: https://example.com/expo\n<b>前売り</b> &amp; 当日\n  末尾の空白  `;
    const location = '東京都千代田区丸の内1-1 (テスト)';
    const schedule = await connector.create({ title: `${runLabel} text`, start: day, description, location });
    remember(schedule.id);
    expect(schedule).toMatchObject({ description, location });
    expect(await rawEvent(schedule.id)).toMatchObject({ description, location });

    const listed = await connector.list({ start: day, end: day, calendar: defaultAlias });
    expect(listed.find((s) => s.id === schedule.id)).toMatchObject({ description, location });
  });

  it('stores an event period with an exclusive end and finds it by overlap', async () => {
    const first = addDays(day, 10);
    const last = addDays(first, 2);
    const period = await connector.create({ title: `${runLabel} period`, start: first, end: last });
    remember(period.id);
    expect((await rawEvent(period.id)).end).toEqual({ date: addDays(last, 1) });

    const found = async (start: string, end: string) =>
      (await connector.list({ start, end, calendar: defaultAlias })).some((s) => s.id === period.id);
    expect(await found(addDays(first, 1), addDays(first, 1))).toBe(true); // inside, starting after its first day
    expect(await found(addDays(first, -5), first)).toBe(true); // ending on its first day
    expect(await found(last, addDays(last, 5))).toBe(true); // starting on its last day
    expect(await found(addDays(first, -30), addDays(last, 30))).toBe(true); // containing it
    expect(await found(addDays(first, -5), addDays(first, -1))).toBe(false);
    expect(await found(addDays(last, 1), addDays(last, 5))).toBe(false);
    const listed = await connector.list({ start: first, end: first, calendar: defaultAlias });
    expect(listed.find((s) => s.id === period.id)).toMatchObject({ start: first, end: last });
  });

  it('writes each alias to its own calendar only', async () => {
    const aliases = Object.keys(writableCalendars);
    const schedules = [];
    for (const alias of aliases) {
      const schedule = await connector.create({ title: `${runLabel} ${alias}`, start: day, calendar: alias });
      const { calendarId } = remember(schedule.id);
      expect(calendarId).toBe(writableCalendars[alias]);
      expect(schedule.calendar).toBe(alias);
      schedules.push(schedule);
    }
    for (const [index, alias] of aliases.entries()) {
      const { eventId } = parseScheduleId(schedules[index]!.id!);
      for (const other of aliases.filter((name) => name !== alias)) {
        const fetched = await raw.events.get({ calendarId: writableCalendars[other]!, eventId }).then(
          () => 'found',
          (error: { status?: number }) => error.status,
        );
        expect(fetched).toBe(404);
      }
      const { data } = await raw.calendarList.get({ calendarId: writableCalendars[alias]! });
      expect(['owner', 'writer']).toContain(data.accessRole);
      console.error(`[integration] ${alias}: "${data.summary}" (${data.accessRole})`);
    }
  });

  it('lists one calendar by alias without the others', async () => {
    const aliases = Object.keys(writableCalendars);
    if (aliases.length < 2) return; // needs a second writable calendar
    const [first, second] = aliases as [string, string];
    const a = await connector.create({ title: `${runLabel} only-${first}`, start: day, calendar: first });
    remember(a.id);
    const b = await connector.create({ title: `${runLabel} only-${second}`, start: day, calendar: second });
    remember(b.id);
    const ids = async (calendar: string) =>
      (await connector.list({ start: day, end: day, calendar })).map((s) => s.id);
    expect(await ids(first)).toContain(a.id);
    expect(await ids(first)).not.toContain(b.id);
    expect(await ids(second)).toContain(b.id);
    expect(await ids(second)).not.toContain(a.id);
  });

  it('updates only the given fields', async () => {
    const start = `${day}T10:00:00+09:00`;
    const end = `${day}T11:00:00+09:00`;
    const schedule = await connector.create({
      title: `${runLabel} update`,
      start,
      end,
      description: '最初の説明',
      location: '最初の場所',
    });
    remember(schedule.id);
    const id = schedule.id!;

    expect(await connector.update({ id, title: `${runLabel} renamed` })).toMatchObject({
      title: `${runLabel} renamed`,
      start,
      end,
      description: '最初の説明',
      location: '最初の場所',
    });

    const html = '<p>更新</p>\n<ul><li>a</li></ul>';
    expect(await connector.update({ id, description: html })).toMatchObject({ description: html, location: '最初の場所' });

    expect(await connector.update({ id, description: null, location: null })).toMatchObject({
      description: null,
      location: null,
    });
    const cleared = await rawEvent(id);
    expect(cleared.description ?? null).toBeNull();
    expect(cleared.location ?? null).toBeNull();

    const before = await rawEvent(id);
    await connector.update({ id, start: `${day}T09:00:00+09:00` });
    const moved = await rawEvent(id);
    expect(moved.start?.dateTime).toBe(`${day}T09:00:00+09:00`);
    expect(moved.end).toEqual(before.end); // the other end point and its timeZone are untouched

    expect(await connector.update({ id, start: day, end: addDays(day, 1) })).toMatchObject({
      start: day,
      end: addDays(day, 1),
    });
    expect((await rawEvent(id)).end).toEqual({ date: addDays(day, 2) });

    await expect(connector.update({ id, end: addDays(day, -1) })).rejects.toBeInstanceOf(InputValidationError);
  });

  it('extends an event period by its last day only', async () => {
    const period = await connector.create({ title: `${runLabel} extend`, start: day, end: addDays(day, 1) });
    remember(period.id);
    expect(await connector.update({ id: period.id!, end: addDays(day, 3) })).toMatchObject({
      start: day,
      end: addDays(day, 3),
    });
    expect(await rawEvent(period.id)).toMatchObject({ start: { date: day }, end: { date: addDays(day, 4) } });
  });

  it('refuses to update a recurring series or its instances', async () => {
    const { data: series } = await raw.events.insert({
      calendarId: defaultCalendarId,
      requestBody: {
        summary: `${runLabel} recurring`,
        start: { dateTime: `${day}T08:00:00`, timeZone },
        end: { dateTime: `${day}T08:30:00`, timeZone },
        recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
      },
    });
    created.push({ calendarId: defaultCalendarId, eventId: series.id! });
    const instance = (await connector.list({ start: day, end: day, calendar: defaultAlias })).find(
      (s) => s.title === `${runLabel} recurring`,
    );
    expect(instance).toBeDefined();

    for (const id of [instance!.id!, `google_calendar:${defaultCalendarId}:${series.id}`]) {
      await expect(connector.update({ id, title: 'changed' })).rejects.toBeInstanceOf(InputValidationError);
    }
    expect((await raw.events.get({ calendarId: defaultCalendarId, eventId: series.id! })).data.summary).toBe(
      `${runLabel} recurring`,
    );
  });

  it('refuses to update an event on a calendar it does not write to', async () => {
    const { data } = await raw.calendarList.list({ showHidden: true });
    const other = (data.items ?? []).find((entry) => entry.id && !Object.values(writableCalendars).includes(entry.id));
    if (!other) return; // no other readable calendar
    await expect(
      connector.update({ id: `google_calendar:${other.id}:nonexistent`, title: 'x' }),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  it('reads every calendar the user can read, including hidden ones', async () => {
    const api = await lazyCalendarApi(credentials)();
    const queried: string[] = [];
    const recording = new GoogleCalendarScheduleConnector({
      api: async () => ({
        ...api,
        listEvents: (calendarId, range) => {
          queried.push(calendarId);
          return api.listEvents(calendarId, range);
        },
      }),
      writableCalendars,
      defaultCalendar: defaultAlias,
      timeZone,
    });

    await recording.list({ start: daysFromToday(-7), end: daysFromToday(7) });

    // Every calendar whose events the user can read, hidden or not (free/busy-only ones excluded).
    const readable: calendar_v3.Schema$CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await raw.calendarList.list({ showHidden: true, pageToken });
      readable.push(...(data.items ?? []).filter((entry) => entry.accessRole !== 'freeBusyReader'));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    expect([...queried].sort()).toEqual(readable.map((entry) => entry.id).sort());
    for (const calendarId of Object.values(writableCalendars)) expect(queried).toContain(calendarId);
    const hidden = readable.filter((entry) => entry.hidden).map((entry) => entry.id);
    console.error(`[integration] calendars read: ${readable.length} (hidden: ${hidden.length})`);
  });
});
