import { describe, expect, it } from 'vitest';
import {
  ScheduleCreateInputSchema,
  ScheduleListFilterSchema,
  ScheduleSchema,
  normalizeScheduleCreateInput,
} from '../../src/domain/index.js';

const base = { type: 'schedule', title: 'AI Foundationを進める', start: '2026-10-17T14:00:00+09:00' };

describe('ScheduleSchema', () => {
  it('accepts an open-ended schedule', () => {
    expect(ScheduleSchema.safeParse({ ...base, end: null }).success).toBe(true);
  });

  it('accepts a timed schedule with end and metadata', () => {
    const result = ScheduleSchema.safeParse({
      ...base,
      id: 'google_calendar:primary:abc',
      source: 'google_calendar',
      end: '2026-10-17T15:00:00+09:00',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an all-day schedule, including a single day with end == start', () => {
    expect(ScheduleSchema.safeParse({ ...base, start: '2026-10-19', end: '2026-10-21' }).success).toBe(true);
    expect(ScheduleSchema.safeParse({ ...base, start: '2026-10-19', end: '2026-10-19' }).success).toBe(true);
  });

  it('does not carry related_task', () => {
    const result = ScheduleSchema.safeParse({ ...base, related_task: 'todoist:123' });
    expect(result.success && 'related_task' in result.data).toBe(false);
  });

  it('compares start and end across offsets', () => {
    // 14:00+09:00 is 05:00Z.
    expect(ScheduleSchema.safeParse({ ...base, end: '2026-10-17T06:00:00Z' }).success).toBe(true);
    expect(ScheduleSchema.safeParse({ ...base, end: '2026-10-17T04:00:00Z' }).success).toBe(false);
  });

  it('rejects end earlier than start with the issue on end', () => {
    const result = ScheduleSchema.safeParse({ ...base, end: '2026-10-17T13:00:00+09:00' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['end']);
  });

  it.each([
    ['missing start', { type: 'schedule', title: 'a' }],
    ['invalid start', { ...base, start: 'tomorrow 14:00' }],
    ['start without offset', { ...base, start: '2026-10-17T14:00:00' }],
    ['a date start with a date-time end', { ...base, start: '2026-10-17', end: '2026-10-17T15:00:00+09:00' }],
    ['an all-day end before start', { ...base, start: '2026-10-19', end: '2026-10-18' }],
  ])('rejects %s', (_label, input) => {
    expect(ScheduleSchema.safeParse(input).success).toBe(false);
  });
});

describe('ScheduleCreateInputSchema', () => {
  it.each([
    ['timed with end', { start: '2026-10-17T14:00:00+09:00', end: '2026-10-17T15:00:00+09:00' }],
    ['timed without end', { start: '2026-10-17T14:00:00+09:00' }],
    ['timed with null end', { start: '2026-10-17T14:00:00+09:00', end: null }],
    ['all-day single day', { start: '2026-10-19' }],
    ['all-day multiple days', { start: '2026-10-19', end: '2026-10-21' }],
    ['all-day with end == start', { start: '2026-10-19', end: '2026-10-19' }],
  ])('accepts %s', (_label, fields) => {
    expect(ScheduleCreateInputSchema.safeParse({ title: 'a', ...fields }).success).toBe(true);
  });

  it.each([
    ['mixed date and date-time', { start: '2026-10-19', end: '2026-10-19T15:00:00+09:00' }],
    ['mixed date-time and date', { start: '2026-10-19T14:00:00+09:00', end: '2026-10-20' }],
    ['end earlier than start', { start: '2026-10-17T14:00:00+09:00', end: '2026-10-17T13:00:00+09:00' }],
    ['all-day end earlier than start', { start: '2026-10-19', end: '2026-10-18' }],
    ['a calendar_id', { start: '2026-10-19', calendar_id: 'someone@example.com' }],
    ['related_task', { start: '2026-10-19', related_task: null }],
  ])('rejects %s', (_label, fields) => {
    expect(ScheduleCreateInputSchema.safeParse({ title: 'a', ...fields }).success).toBe(false);
  });
});

describe('ScheduleListFilterSchema', () => {
  it.each([
    ['dates', { start: '2026-10-12', end: '2026-10-18' }],
    ['date-times', { start: '2026-10-12T00:00:00+09:00', end: '2026-10-19T00:00:00+09:00' }],
    ['a single day', { start: '2026-10-14', end: '2026-10-14' }],
    ['mixed kinds (ordered by the connector)', { start: '2026-10-14', end: '2026-10-14T05:00:00+09:00' }],
  ])('accepts %s', (_label, input) => {
    expect(ScheduleListFilterSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['missing start', { end: '2026-10-18' }],
    ['missing end', { start: '2026-10-12' }],
    ['end before start', { start: '2026-10-18', end: '2026-10-12' }],
  ])('rejects %s', (_label, input) => {
    expect(ScheduleListFilterSchema.safeParse(input).success).toBe(false);
  });

  it.each([true, false])('keeps attended_only: %s', (attended_only) => {
    expect(ScheduleListFilterSchema.parse({ start: '2026-10-12', end: '2026-10-18', attended_only })).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
      attended_only,
    });
  });

  it('adds no attended_only when it is omitted', () => {
    expect(ScheduleListFilterSchema.parse({ start: '2026-10-12', end: '2026-10-18' })).not.toHaveProperty(
      'attended_only',
    );
  });

  it.each([
    ['attended_only: null', { attended_only: null }],
    ['attended_only: "true"', { attended_only: 'true' }],
    ['attended_only: 1', { attended_only: 1 }],
    ['an unknown attended key', { attended: true }],
    ['an unknown attendedOnly key', { attendedOnly: true }],
  ])('rejects %s', (_label, extra) => {
    expect(ScheduleListFilterSchema.safeParse({ start: '2026-10-12', end: '2026-10-18', ...extra }).success).toBe(
      false,
    );
  });

  it('still rejects end before start with attended_only', () => {
    const result = ScheduleListFilterSchema.safeParse({ start: '2026-10-18', end: '2026-10-12', attended_only: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['end']]);
  });
});

describe('normalizeScheduleCreateInput', () => {
  it('defaults a timed event to one hour, keeping the input offset', () => {
    expect(normalizeScheduleCreateInput({ title: 'a', start: '2026-10-17T14:00:00+09:00' })).toEqual({
      kind: 'timed',
      title: 'a',
      start: '2026-10-17T14:00:00+09:00',
      end: '2026-10-17T15:00:00+09:00',
    });
    expect(normalizeScheduleCreateInput({ title: 'a', start: '2026-10-14T20:00:00+02:00' })).toMatchObject({
      end: '2026-10-14T21:00:00+02:00',
    });
  });

  it('crosses midnight when adding the default hour', () => {
    expect(normalizeScheduleCreateInput({ title: 'a', start: '2026-12-31T23:30:00-05:00' })).toMatchObject({
      end: '2027-01-01T00:30:00-05:00',
    });
  });

  it('keeps an explicit end', () => {
    expect(
      normalizeScheduleCreateInput({ title: 'a', start: '2026-10-17T14:00:00+09:00', end: '2026-10-17T17:00:00+09:00' }),
    ).toMatchObject({ end: '2026-10-17T17:00:00+09:00' });
  });

  it('defaults an all-day event to a single day', () => {
    expect(normalizeScheduleCreateInput({ title: 'a', start: '2026-10-19', end: null })).toEqual({
      kind: 'all_day',
      title: 'a',
      startDate: '2026-10-19',
      endDate: '2026-10-19',
    });
  });

  it('keeps the inclusive end of a multi-day all-day event', () => {
    expect(normalizeScheduleCreateInput({ title: 'a', start: '2026-10-19', end: '2026-10-21' })).toMatchObject({
      startDate: '2026-10-19',
      endDate: '2026-10-21',
    });
  });
});
