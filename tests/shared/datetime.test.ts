import { describe, expect, it } from 'vitest';
import {
  addDays,
  addHoursKeepingOffset,
  formatInTimeZone,
  localDateOf,
  startOfDay,
  timeZoneOffset,
  toUtcDateTime,
  zonedDateTimeToInstant,
} from '../../src/shared/datetime.js';

describe('addDays', () => {
  it.each([
    ['2026-10-19', 1, '2026-10-20'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-03-01', -1, '2026-02-28'],
  ])('%s + %i = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe('addHoursKeepingOffset', () => {
  it.each([
    ['2026-10-17T14:00:00+09:00', '2026-10-17T15:00:00+09:00'],
    ['2026-10-14T20:00:00+02:00', '2026-10-14T21:00:00+02:00'],
    ['2026-10-17T23:30:00-05:30', '2026-10-18T00:30:00-05:30'],
    ['2026-10-17T05:00:00Z', '2026-10-17T06:00:00+00:00'],
  ])('%s + 1h = %s', (start, expected) => {
    expect(addHoursKeepingOffset(start, 1)).toBe(expected);
  });
});

describe('time zones', () => {
  it('reads the offset of a zone at an instant, including DST', () => {
    expect(timeZoneOffset('Asia/Tokyo', Date.parse('2026-07-01T00:00:00Z'))).toBe(540);
    expect(timeZoneOffset('America/New_York', Date.parse('2026-07-01T12:00:00Z'))).toBe(-240);
    expect(timeZoneOffset('America/New_York', Date.parse('2026-12-01T12:00:00Z'))).toBe(-300);
    expect(timeZoneOffset('UTC', Date.parse('2026-12-01T12:00:00Z'))).toBe(0);
  });

  it('formats an instant in a zone', () => {
    const instant = Date.parse('2026-10-17T05:00:00Z');
    expect(formatInTimeZone(instant, 'Asia/Tokyo')).toBe('2026-10-17T14:00:00+09:00');
    expect(formatInTimeZone(instant, 'America/New_York')).toBe('2026-10-17T01:00:00-04:00');
  });

  it('resolves a local date-time in a zone', () => {
    expect(zonedDateTimeToInstant('2026-10-17T14:00:00', 'Asia/Tokyo')).toBe(Date.parse('2026-10-17T05:00:00Z'));
    expect(zonedDateTimeToInstant('2026-07-01T09:00:00', 'America/New_York')).toBe(
      Date.parse('2026-07-01T13:00:00Z'),
    );
    expect(zonedDateTimeToInstant('2026-12-01T09:00:00', 'America/New_York')).toBe(
      Date.parse('2026-12-01T14:00:00Z'),
    );
  });

  it('finds the start of a day', () => {
    expect(startOfDay('2026-10-17', 'Asia/Tokyo')).toBe(Date.parse('2026-10-16T15:00:00Z'));
    // 2026-11-01 is the DST end day in New York; midnight is still EDT.
    expect(startOfDay('2026-11-01', 'America/New_York')).toBe(Date.parse('2026-11-01T04:00:00Z'));
  });

  it('finds the local date of an instant', () => {
    const instant = Date.parse('2026-10-16T16:00:00Z');
    expect(localDateOf(instant, 'Asia/Tokyo')).toBe('2026-10-17');
    expect(localDateOf(instant, 'America/New_York')).toBe('2026-10-16');
  });
});

describe('toUtcDateTime', () => {
  it('converts an offset date-time to UTC without milliseconds', () => {
    expect(toUtcDateTime('2026-10-17T14:00:00+09:00')).toBe('2026-10-17T05:00:00Z');
  });
});
