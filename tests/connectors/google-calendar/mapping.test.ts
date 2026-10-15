import { describe, expect, it } from 'vitest';
import {
  startInstant,
  toGoogleEvent,
  toSchedule,
  toTimeRange,
} from '../../../src/connectors/google-calendar/mapping.js';
import { InputValidationError } from '../../../src/errors.js';

const TZ = 'Asia/Tokyo';

describe('toGoogleEvent', () => {
  it('sends a timed event in its own offset without timeZone', () => {
    expect(
      toGoogleEvent({ kind: 'timed', title: 'a', start: '2026-10-14T20:00:00+02:00', end: '2026-10-14T21:00:00+02:00' }),
    ).toEqual({
      summary: 'a',
      start: { dateTime: '2026-10-14T20:00:00+02:00' },
      end: { dateTime: '2026-10-14T21:00:00+02:00' },
    });
  });

  it('makes the all-day end exclusive', () => {
    expect(toGoogleEvent({ kind: 'all_day', title: 'a', startDate: '2026-10-19', endDate: '2026-10-19' })).toEqual({
      summary: 'a',
      start: { date: '2026-10-19' },
      end: { date: '2026-10-20' },
    });
    expect(
      toGoogleEvent({ kind: 'all_day', title: 'a', startDate: '2026-10-30', endDate: '2026-11-01' }).end,
    ).toEqual({ date: '2026-11-02' });
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
    expect(toSchedule(event, 'af@group.calendar.google.com')).toEqual({
      id: 'google_calendar:af@group.calendar.google.com:evt1',
      source: 'google_calendar',
      external_ref: 'https://www.google.com/calendar/event?eid=x',
      type: 'schedule',
      title: 'AI Foundationを進める',
      start: '2026-10-17T14:00:00+09:00',
      end: '2026-10-17T15:00:00+09:00',
    });
  });

  it('makes the all-day end inclusive', () => {
    const single = toSchedule({ id: 'e', summary: 'a', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } }, 'c');
    expect(single).toMatchObject({ start: '2026-10-19', end: '2026-10-19' });
    const multi = toSchedule({ id: 'e', summary: 'a', start: { date: '2026-10-19' }, end: { date: '2026-10-22' } }, 'c');
    expect(multi).toMatchObject({ start: '2026-10-19', end: '2026-10-21' });
  });

  it('names an untitled event and skips one without start', () => {
    expect(toSchedule({ id: 'e', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } }, 'c')?.title).toBe(
      '(No title)',
    );
    expect(toSchedule({ id: 'e', summary: '  ', start: { date: '2026-10-19' } }, 'c')).toMatchObject({
      title: '(No title)',
      end: null,
    });
    expect(toSchedule({ id: 'e', summary: 'a' }, 'c')).toBeUndefined();
  });
});

describe('startInstant', () => {
  it('starts all-day events at the beginning of the day in the time zone', () => {
    expect(startInstant({ type: 'schedule', title: 'a', start: '2026-10-17' }, TZ)).toBe(
      Date.parse('2026-10-16T15:00:00Z'),
    );
    expect(startInstant({ type: 'schedule', title: 'a', start: '2026-10-17T09:00:00+09:00' }, TZ)).toBe(
      Date.parse('2026-10-17T00:00:00Z'),
    );
  });
});
