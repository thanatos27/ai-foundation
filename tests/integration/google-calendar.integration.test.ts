import { calendar } from '@googleapis/calendar';
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
  let deleteEvent: (eventId: string) => Promise<unknown>;
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
    const api = calendar({ version: 'v3', auth });
    // Cleanup only; the connector itself never deletes.
    deleteEvent = (eventId) => api.events.delete({ calendarId: writableCalendarId, eventId });
  });

  afterAll(async () => {
    await Promise.allSettled(created.map((eventId) => deleteEvent(eventId)));
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

  it('reads every calendar the user can read', async () => {
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
    const readable = (await api.listCalendars()).map((entry) => entry.id);
    expect([...queried].sort()).toEqual([...readable].sort());
    expect(queried).toContain(writableCalendarId);
  });
});
