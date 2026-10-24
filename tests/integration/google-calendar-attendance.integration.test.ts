import { beforeAll, describe, expect, it } from 'vitest';
import { lazyCalendarApi } from '../../src/connectors/google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from '../../src/connectors/google-calendar/connector.js';
import type { Schedule } from '../../src/domain/index.js';
import { credentials, daysFromToday, enabled, hasEnv, integrationConfig } from './setup.js';

const run = enabled && hasEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN');

/**
 * Period holding the fixture events created by hand in Google Calendar
 * (docs/plans/schedule-attendance-implementation-plan.md §12.2).
 */
const fixtureStart = process.env.AI_FOUNDATION_IT_ATTENDANCE_START?.trim();
const fixtureEnd = process.env.AI_FOUNDATION_IT_ATTENDANCE_END?.trim();

/**
 * What `attended_only: true` must return for each fixture, by title. Written out by hand rather than
 * computed with the flag check under test.
 */
const FIXTURES = {
  'AF-ATT 1 plain': 'every', // `#attended`, AI Foundation calendar
  'AF-ATT 2 bold': 'every', // `#attended` in bold (stored as HTML)
  'AF-ATT 3 other calendar': 'every', // `#attended`, another calendar
  'AF-ATT 4 all-day': 'every', // all-day, `#attended` (a tagged series: every instance)
  'AF-ATT 5 suffix': 'none', // no flag
  'AF-ATT 6 empty': 'none', // no description
  'AF-ATT 7 daily': 'one', // daily series without flag; one instance edited to `#attended`
} as const;
type FixtureTitle = keyof typeof FIXTURES;

const isFixture = (schedule: Schedule): schedule is Schedule & { title: FixtureTitle } => schedule.title in FIXTURES;
const calendarOf = (schedule: Schedule) => schedule.id?.split(':').slice(1, -1).join(':');

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

  describe.runIf(!!fixtureStart && !!fixtureEnd)('fixture events', () => {
    let all: (Schedule & { title: FixtureTitle })[];
    let attended: (Schedule & { title: FixtureTitle })[];

    beforeAll(async () => {
      const period = { start: fixtureStart ?? '', end: fixtureEnd ?? '' };
      all = (await connector.list(period)).filter(isFixture);
      attended = (await connector.list({ ...period, attended_only: true })).filter(isFixture);
    });

    it('finds every fixture in the period', () => {
      // Fails rather than skips when a fixture is missing.
      expect([...new Set(all.map((s) => s.title))].sort()).toEqual(Object.keys(FIXTURES).sort());
      expect(all.filter((s) => s.title === 'AF-ATT 7 daily').length).toBeGreaterThan(1);
      expect(calendarOf(all.find((s) => s.title === 'AF-ATT 3 other calendar')!)).not.toBe(
        calendarOf(all.find((s) => s.title === 'AF-ATT 1 plain')!),
      );
    });

    it('returns every instance of the tagged fixtures, in the order of the plain list', () => {
      const tagged = (list: Schedule[]) => list.filter((s) => isFixture(s) && FIXTURES[s.title] === 'every');
      expect(tagged(attended)).toEqual(tagged(all));
    });

    it('returns no untagged fixture', () => {
      expect(attended.filter((s) => FIXTURES[s.title] === 'none')).toEqual([]);
    });

    it('returns exactly one instance of the series edited for one day', () => {
      const daily = attended.filter((s) => s.title === 'AF-ATT 7 daily');
      expect(daily).toHaveLength(1);
      expect(all).toContainEqual(daily[0]);
    });

    it('keeps all-day fixtures as inclusive dates', () => {
      const allDay = attended.filter((s) => s.title === 'AF-ATT 4 all-day');
      expect(allDay.length).toBeGreaterThan(0);
      for (const s of allDay) expect(s.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const s of allDay) expect(s.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
