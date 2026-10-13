import { describe, expect, it } from 'vitest';
import { matchesFilter } from '../../../src/connectors/todoist/filter.js';
import type { Task, TaskListFilter } from '../../../src/domain/index.js';

const TZ = 'Asia/Tokyo';

const task = (fields: Partial<Task>): Task => ({ type: 'task', title: 'a', status: 'inbox', tags: [], ...fields });
const matches = (fields: Partial<Task>, filter: TaskListFilter) => matchesFilter(task(fields), filter, TZ);

describe('matchesFilter', () => {
  it('matches everything with an empty filter, including tasks without due', () => {
    expect(matches({}, {})).toBe(true);
    expect(matches({ status: 'someday', due: '2026-10-16' }, {})).toBe(true);
  });

  it('matches any of the given statuses', () => {
    expect(matches({ status: 'next' }, { status: ['next', 'waiting'] })).toBe(true);
    expect(matches({ status: 'inbox' }, { status: ['next', 'waiting'] })).toBe(false);
    expect(matches({ status: 'inbox' }, { status: [] })).toBe(true);
  });

  it('matches the area exactly', () => {
    expect(matches({ area: 'work' }, { area: 'work' })).toBe(true);
    expect(matches({ area: null }, { area: 'work' })).toBe(false);
    expect(matches({ area: 'personal' }, { area: 'work' })).toBe(false);
  });

  it('requires all tags', () => {
    expect(matches({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toBe(true);
    expect(matches({ tags: ['a'] }, { tags: ['a', 'b'] })).toBe(false);
  });

  it('excludes tasks without due when a due bound is set', () => {
    expect(matches({ due: null }, { due_before: '2026-10-31' })).toBe(false);
    expect(matches({}, { due_after: '2026-10-01' })).toBe(false);
  });

  it('includes both date bounds', () => {
    const filter = { due_after: '2026-10-10', due_before: '2026-10-16' };
    expect(matches({ due: '2026-10-10' }, filter)).toBe(true);
    expect(matches({ due: '2026-10-16' }, filter)).toBe(true);
    expect(matches({ due: '2026-10-09' }, filter)).toBe(false);
    expect(matches({ due: '2026-10-17' }, filter)).toBe(false);
  });

  it('compares two date-times as instants', () => {
    const due = '2026-10-16T18:00:00+09:00';
    expect(matches({ due }, { due_before: '2026-10-16T09:00:00Z' })).toBe(true);
    expect(matches({ due }, { due_before: '2026-10-16T08:59:59Z' })).toBe(false);
    expect(matches({ due }, { due_after: '2026-10-16T09:00:01Z' })).toBe(false);
  });

  it('compares a date-time due with a date bound by its local date', () => {
    // 2026-10-16T16:00Z is 2026-10-17 01:00 in Tokyo.
    const due = '2026-10-16T16:00:00Z';
    expect(matches({ due }, { due_before: '2026-10-16' })).toBe(false);
    expect(matches({ due }, { due_before: '2026-10-17' })).toBe(true);
    expect(matches({ due }, { due_after: '2026-10-17' })).toBe(true);
  });

  it('compares a date due with a date-time bound by the bound local date', () => {
    expect(matches({ due: '2026-10-17' }, { due_before: '2026-10-16T16:00:00Z' })).toBe(true);
    expect(matches({ due: '2026-10-18' }, { due_before: '2026-10-16T16:00:00Z' })).toBe(false);
  });
});
