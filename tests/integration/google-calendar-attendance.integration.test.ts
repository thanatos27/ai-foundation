import { beforeAll, describe, expect, it } from 'vitest';
import { lazyCalendarApi } from '../../src/connectors/google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from '../../src/connectors/google-calendar/connector.js';
import type { Schedule } from '../../src/domain/index.js';
import { addDays } from '../../src/shared/datetime.js';
import { credentials, daysFromToday, enabled, hasEnv, integrationConfig } from './setup.js';

const run = enabled && hasEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN');

/** Day of the fixture events created by hand in Google Calendar (docs/specs/schedule-attendance.md). */
const fixtureDay = process.env.AI_FOUNDATION_IT_ATTENDANCE_DATE?.trim();
const FIXTURE_PREFIX = 'AF-ATT ';

/**
 * Read-only: flags are written by hand in the Google Calendar UI, never by AI Foundation or this test.
 * Titles and descriptions of the user's own events are never printed.
 */
describe.runIf(run)('Google Calendar attendance flag (real API, read-only)', () => {
  let connector: GoogleCalendarScheduleConnector;

  beforeAll(async () => {
    const config = await integrationConfig();
    connector = new GoogleCalendarScheduleConnector({
      api: lazyCalendarApi(credentials),
      writableCalendarId: config.sources.schedule.writable_calendar_id,
      timeZone: config.defaults.timezone,
    });
  });

  it('returns a subsequence of the plain list, and false behaves like omitted', async () => {
    const period = { start: daysFromToday(-30), end: daysFromToday(30) };
    const all = await connector.list(period);
    const notOnly = await connector.list({ ...period, attended_only: false });
    const attended = await connector.list({ ...period, attended_only: true });

    expect(notOnly).toEqual(all);
    const byId = new Map(all.map((schedule) => [schedule.id, schedule]));
    for (const schedule of attended) expect(schedule).toEqual(byId.get(schedule.id));
    const positions = attended.map((schedule) => all.findIndex((s) => s.id === schedule.id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    console.error(`[integration] schedules: ${all.length}, attended: ${attended.length}`);
  });

  describe.runIf(!!fixtureDay)('fixture events', () => {
    const day = fixtureDay ?? '';
    const period = () => ({ start: day, end: addDays(day, 2) });
    const fixtures = (schedules: Schedule[]) =>
      schedules
        .filter((s) => s.title.startsWith(FIXTURE_PREFIX))
        .map((s) => [s.title, s.start.slice(0, 10), s.end?.slice(0, 10)]);

    it('returns only the tagged fixtures, in order', async () => {
      const attended = fixtures(await connector.list({ ...period(), attended_only: true }));
      expect(attended).toEqual([
        ['AF-ATT 4 all-day', day, addDays(day, 1)],
        ['AF-ATT 1 plain', day, day],
        ['AF-ATT 2 bold', day, day],
        ['AF-ATT 3 other calendar', day, day],
        ['AF-ATT 7 daily', addDays(day, 1), addDays(day, 1)],
      ]);
    });

    it('returns every fixture without attended_only', async () => {
      const all = fixtures(await connector.list(period()));
      // Fails rather than skips when the fixtures are missing.
      expect(all.map(([title, start]) => `${start} ${title}`).sort()).toEqual(
        [
          `${day} AF-ATT 1 plain`,
          `${day} AF-ATT 2 bold`,
          `${day} AF-ATT 3 other calendar`,
          `${day} AF-ATT 4 all-day`,
          `${day} AF-ATT 5 suffix`,
          `${day} AF-ATT 6 empty`,
          `${day} AF-ATT 7 daily`,
          `${addDays(day, 1)} AF-ATT 7 daily`,
          `${addDays(day, 2)} AF-ATT 7 daily`,
        ].sort(),
      );
    });
  });
});
