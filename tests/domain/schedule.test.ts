import { describe, expect, it } from 'vitest';
import { ScheduleCreateInputSchema, ScheduleSchema } from '../../src/domain/index.js';

const base = { type: 'schedule', title: 'AI Foundationを進める', start: '2026-10-17T14:00:00+09:00' };

describe('ScheduleSchema', () => {
  it('accepts an open-ended schedule', () => {
    expect(ScheduleSchema.safeParse({ ...base, end: null }).success).toBe(true);
  });

  it('accepts end and related_task', () => {
    const result = ScheduleSchema.safeParse({ ...base, end: '2026-10-17T15:00:00+09:00', related_task: 'todoist:123' });
    expect(result.success).toBe(true);
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
    ['date-only start', { ...base, start: '2026-10-17' }],
  ])('rejects %s', (_label, input) => {
    expect(ScheduleSchema.safeParse(input).success).toBe(false);
  });
});

describe('ScheduleCreateInputSchema', () => {
  it('accepts the spec §9 shape', () => {
    const result = ScheduleCreateInputSchema.safeParse({
      title: 'AI Foundationを進める',
      start: '2026-10-17T14:00:00+09:00',
      end: '2026-10-17T15:00:00+09:00',
      related_task: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects end earlier than start', () => {
    const result = ScheduleCreateInputSchema.safeParse({
      title: 'a',
      start: '2026-10-17T14:00:00+09:00',
      end: '2026-10-17T13:00:00+09:00',
    });
    expect(result.success).toBe(false);
  });
});
