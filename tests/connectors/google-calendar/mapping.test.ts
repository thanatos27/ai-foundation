import { describe, expect, it } from 'vitest';
import type { GoogleEvent } from '../../../src/connectors/google-calendar/client.js';
import {
  parseScheduleId,
  startInstant,
  toEventPatch,
  toGoogleEvent,
  toSchedule,
  toTimeRange,
} from '../../../src/connectors/google-calendar/mapping.js';
import { InputValidationError } from '../../../src/errors.js';

const TZ = 'Asia/Tokyo';
const NO_TEXT = { description: null, location: null };

describe('toGoogleEvent', () => {
  it('sends a timed event in its own offset without timeZone', () => {
    expect(
      toGoogleEvent({ kind: 'timed', title: 'a', ...NO_TEXT, start: '2026-10-14T20:00:00+02:00', end: '2026-10-14T21:00:00+02:00' }),
    ).toEqual({
      summary: 'a',
      start: { dateTime: '2026-10-14T20:00:00+02:00' },
      end: { dateTime: '2026-10-14T21:00:00+02:00' },
    });
  });

  it('makes the all-day end exclusive', () => {
    expect(toGoogleEvent({ kind: 'all_day', title: 'a', ...NO_TEXT, startDate: '2026-10-19', endDate: '2026-10-19' })).toEqual({
      summary: 'a',
      start: { date: '2026-10-19' },
      end: { date: '2026-10-20' },
    });
    expect(
      toGoogleEvent({ kind: 'all_day', title: 'a', ...NO_TEXT, startDate: '2026-10-30', endDate: '2026-11-01' }).end,
    ).toEqual({ date: '2026-11-02' });
  });

  it('sends description and location as given, and only when set', () => {
    const description = '1行目\n<b>2行目</b> &amp;\n';
    expect(
      toGoogleEvent({ kind: 'all_day', title: 'a', description, location: ' 会場 ', startDate: '2026-11-01', endDate: '2026-11-03' }),
    ).toEqual({
      summary: 'a',
      description,
      location: ' 会場 ',
      start: { date: '2026-11-01' },
      end: { date: '2026-11-04' },
    });
  });
});

describe('toTimeRange', () => {
  it('covers whole days for dates, end inclusive', () => {
    expect(toTimeRange({ start: '2026-10-12', end: '2026-10-18' }, TZ)).toEqual({
      timeMin: '2026-10-11T15:00:00.000Z',
      timeMax: '2026-10-18T15:00:00.000Z',
    });
  });

  it('starts and ends days at their first instant across a midnight DST gap', () => {
    // Cuba skips 2026-03-08 00:00–01:00: the day starts at 01:00 local (05:00Z), not on 03-07.
    expect(toTimeRange({ start: '2026-03-08', end: '2026-03-08' }, 'America/Havana')).toEqual({
      timeMin: '2026-03-08T05:00:00.000Z',
      timeMax: '2026-03-09T04:00:00.000Z',
    });
  });

  it('passes date-times through', () => {
    const range = { start: '2026-10-12T09:00:00+09:00', end: '2026-10-12T18:00:00+09:00' };
    expect(toTimeRange(range, TZ)).toEqual({ timeMin: range.start, timeMax: range.end });
  });

  it('mixes a date start with a date-time end', () => {
    expect(toTimeRange({ start: '2026-10-14', end: '2026-10-14T12:00:00+09:00' }, TZ)).toEqual({
      timeMin: '2026-10-13T15:00:00.000Z',
      timeMax: '2026-10-14T12:00:00+09:00',
    });
  });

  it('rejects a mixed period whose end is before its start in the time zone', () => {
    expect(() => toTimeRange({ start: '2026-10-14', end: '2026-10-13T23:00:00+09:00' }, TZ)).toThrow(
      InputValidationError,
    );
  });
});

describe('toSchedule', () => {
  it('maps a timed event', () => {
    const event = {
      id: 'evt1',
      summary: 'AI Foundationを進める',
      htmlLink: 'https://www.google.com/calendar/event?eid=x',
      start: { dateTime: '2026-10-17T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
      end: { dateTime: '2026-10-17T15:00:00+09:00', timeZone: 'Asia/Tokyo' },
    };
    expect(toSchedule(event, 'af@group.calendar.google.com', 'personal')).toEqual({
      id: 'google_calendar:af@group.calendar.google.com:evt1',
      source: 'google_calendar',
      external_ref: 'https://www.google.com/calendar/event?eid=x',
      type: 'schedule',
      calendar: 'personal',
      title: 'AI Foundationを進める',
      start: '2026-10-17T14:00:00+09:00',
      end: '2026-10-17T15:00:00+09:00',
      description: null,
      location: null,
    });
  });

  it('returns description and location exactly as stored, empty ones as null', () => {
    const base = { id: 'e', summary: 'a', start: { date: '2026-10-19' } };
    const description = '  <p>公式</p>\r\n<a href="https://example.com">x</a>  ';
    expect(toSchedule({ ...base, description, location: ' 会場 ' }, 'c', 'c')).toMatchObject({
      description,
      location: ' 会場 ',
    });
    expect(toSchedule({ ...base, description: '', location: '' }, 'c', 'c')).toMatchObject({ description: null, location: null });
    expect(toSchedule({ ...base, description: null }, 'c', 'c')).toMatchObject({ description: null, location: null });
  });

  it('makes the all-day end inclusive', () => {
    const single = toSchedule({ id: 'e', summary: 'a', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } }, 'c', 'c');
    expect(single).toMatchObject({ start: '2026-10-19', end: '2026-10-19' });
    const multi = toSchedule({ id: 'e', summary: 'a', start: { date: '2026-10-19' }, end: { date: '2026-10-22' } }, 'c', 'c');
    expect(multi).toMatchObject({ start: '2026-10-19', end: '2026-10-21' });
  });

  it('names an untitled event and skips one without start', () => {
    expect(toSchedule({ id: 'e', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } }, 'c', 'c')?.title).toBe(
      '(No title)',
    );
    expect(toSchedule({ id: 'e', summary: '  ', start: { date: '2026-10-19' } }, 'c', 'c')).toMatchObject({
      title: '(No title)',
      end: null,
    });
    expect(toSchedule({ id: 'e', summary: 'a' }, 'c', 'c')).toBeUndefined();
  });
});

describe('startInstant', () => {
  it('starts all-day events at the beginning of the day in the time zone', () => {
    const base = { type: 'schedule' as const, calendar: 'c', title: 'a', description: null, location: null };
    expect(startInstant({ ...base, start: '2026-10-17' }, TZ)).toBe(
      Date.parse('2026-10-16T15:00:00Z'),
    );
    expect(startInstant({ ...base, start: '2026-10-17T09:00:00+09:00' }, TZ)).toBe(
      Date.parse('2026-10-17T00:00:00Z'),
    );
  });
});

describe('parseScheduleId', () => {
  it.each([
    ['google_calendar:af@group.calendar.google.com:abc123', 'af@group.calendar.google.com', 'abc123'],
    ['google_calendar:ja.japanese#holiday@group.v.calendar.google.com:x1', 'ja.japanese#holiday@group.v.calendar.google.com', 'x1'],
    ['google_calendar:me@example.com:abc_20261020T010000Z', 'me@example.com', 'abc_20261020T010000Z'],
    ['google_calendar:me@example.com:abc_20261020', 'me@example.com', 'abc_20261020'],
  ])('splits %s', (id, calendarId, eventId) => {
    expect(parseScheduleId(id)).toEqual({ calendarId, eventId });
  });

  it.each([
    'todoist:1',
    'google_calendar:',
    'google_calendar:abc',
    'google_calendar::abc',
    'google_calendar:me@example.com:',
    'google_calendar:me@example.com:../x',
    'google_calendar:me@example.com:a b',
    'google_calendar:me @example.com:abc',
  ])('rejects %s', (id) => {
    expect(() => parseScheduleId(id)).toThrow(InputValidationError);
  });
});

describe('toEventPatch', () => {
  const timed: GoogleEvent = {
    start: { dateTime: '2026-11-10T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-11-10T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
  };
  const allDay: GoogleEvent = { start: { date: '2026-11-01' }, end: { date: '2026-11-04' } };
  const id = 'google_calendar:c:e';

  it('sends only the given fields, null to clear', () => {
    expect(toEventPatch({ id, title: 't' }, timed)).toEqual({ summary: 't' });
    expect(toEventPatch({ id, description: 'd\n<b>x</b>', location: null }, timed)).toEqual({
      description: 'd\n<b>x</b>',
      location: null,
    });
  });

  it('sends only the given end point of the same kind', () => {
    expect(toEventPatch({ id, start: '2026-11-10T09:00:00+09:00' }, timed)).toEqual({
      start: { dateTime: '2026-11-10T09:00:00+09:00' },
    });
    expect(toEventPatch({ id, end: '2026-11-10T12:00:00+09:00' }, timed)).toEqual({
      end: { dateTime: '2026-11-10T12:00:00+09:00' },
    });
    expect(toEventPatch({ id, start: '2026-10-31' }, allDay)).toEqual({ start: { date: '2026-10-31' } });
    expect(toEventPatch({ id, end: '2026-11-05' }, allDay)).toEqual({ end: { date: '2026-11-06' } });
  });

  it('sends both end points of the same kind without nulls', () => {
    expect(toEventPatch({ id, start: '2026-11-02', end: '2026-11-03' }, allDay)).toEqual({
      start: { date: '2026-11-02' },
      end: { date: '2026-11-04' },
    });
  });

  it('switches kinds with both end points, nulling the other form', () => {
    expect(toEventPatch({ id, start: '2026-11-10', end: '2026-11-10' }, timed)).toEqual({
      start: { date: '2026-11-10', dateTime: null },
      end: { date: '2026-11-11', dateTime: null },
    });
    expect(toEventPatch({ id, start: '2026-11-01T10:00:00+09:00', end: '2026-11-01T11:00:00+09:00' }, allDay)).toEqual({
      start: { dateTime: '2026-11-01T10:00:00+09:00', date: null },
      end: { dateTime: '2026-11-01T11:00:00+09:00', date: null },
    });
  });

  it.each<[string, { start?: string; end?: string }, GoogleEvent]>([
    ['a date start for a timed event', { start: '2026-11-10' }, timed],
    ['a date-time end for an all-day event', { end: '2026-11-03T10:00:00+09:00' }, allDay],
    ['a start after the end', { start: '2026-11-10T11:00:01+09:00' }, timed],
    ['an end before the start', { end: '2026-10-31' }, allDay],
  ])('rejects only %s', (_label, change, event) => {
    expect(() => toEventPatch({ id, ...change }, event)).toThrow(InputValidationError);
  });

  it('accepts an end equal to the start', () => {
    expect(toEventPatch({ id, end: '2026-11-01' }, allDay)).toEqual({ end: { date: '2026-11-02' } });
  });
});
