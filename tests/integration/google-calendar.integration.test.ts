import { type calendar_v3, calendar } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyCalendarApi } from '../../src/connectors/google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from '../../src/connectors/google-calendar/connector.js';
import { addDays } from '../../src/shared/datetime.js';
import { credentials, daysFromToday, enabled, hasEnv, integrationConfig, runLabel } from './setup.js';

const run = enabled && hasEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN');

describe.runIf(run)('Google Calendar (real API)', () => {
  let connector: GoogleCalendarScheduleConnector;
  let writableCalendarId: string;
  /** Direct googleapis client, independent of the code under test (expectations and cleanup). */
  let raw: calendar_v3.Calendar;
  const created: string[] = [];
  const day = daysFromToday(30);

  beforeAll(async () => {
    const config = await integrationConfig();
    const calendarId = config.sources.schedule.writable_calendar_id;
    if (!calendarId) throw new Error('Set sources.schedule.writable_calendar_id (e.g. in config.local.yaml)');
    writableCalendarId = calendarId;
    connector = new GoogleCalendarScheduleConnector({
      api: lazyCalendarApi(credentials),
      writableCalendarId,
      timeZone: config.defaults.timezone,
    });

    const { clientId, clientSecret, refreshToken } = await credentials.getGoogleOAuthCredentials();
    const auth = new OAuth2Client({ clientId, clientSecret });
    auth.setCredentials({ refresh_token: refreshToken });
    raw = calendar({ version: 'v3', auth });
  });

  afterAll(async () => {
    // The connector itself never deletes.
    await Promise.allSettled(created.map((eventId) => raw.events.delete({ calendarId: writableCalendarId, eventId })));
  });

  const remember = (id: string | undefined) => created.push(id!.split(':').at(-1)!);

  it('creates timed and all-day events on the writable calendar and lists them', async () => {
    const timed = await connector.create({ title: `${runLabel} timed`, start: `${day}T14:00:00+09:00` });
    remember(timed.id);
    expect(timed.id).toContain(writableCalendarId);
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
    expect(ours.map((s) => [s.title, s.start, s.end]).sort()).toEqual(
      [
        [`${runLabel} all-day`, day, day],
        [`${runLabel} multi-day`, day, multiEnd],
        [`${runLabel} timed`, timed.start, timed.end],
      ].sort(),
    );
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
      writableCalendarId,
      timeZone: 'Asia/Tokyo',
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
    expect(queried).toContain(writableCalendarId);
    const hidden = readable.filter((entry) => entry.hidden).map((entry) => entry.id);
    console.error(`[integration] calendars read: ${readable.length} (hidden: ${hidden.length})`);
  });
});
