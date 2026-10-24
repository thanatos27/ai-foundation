import { describe, expect, it } from 'vitest';
import {
  TaskCreateInputSchema,
  TaskIdInputSchema,
  TaskListFilterSchema,
  TaskSchema,
  TaskUpdateInputSchema,
} from '../../src/domain/index.js';

describe('TaskSchema', () => {
  it('accepts the spec §5.2 example (date-only due, no id)', () => {
    const result = TaskSchema.safeParse({
      type: 'task',
      title: '経費精算',
      status: 'next',
      due: '2026-10-16',
      area: 'work',
      project_ref: null,
      tags: ['accounting'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts null due/area and an offset date-time due', () => {
    expect(TaskSchema.safeParse({ type: 'task', title: 'a', status: 'inbox', due: null, area: null }).success).toBe(true);
    expect(TaskSchema.safeParse({ type: 'task', title: 'a', status: 'done', due: '2026-10-16T18:00:00+09:00' }).success).toBe(true);
  });

  it('accepts external-source metadata when present', () => {
    const result = TaskSchema.safeParse({ id: 'todoist:123', source: 'todoist', type: 'task', title: 'a', status: 'next' });
    expect(result.success).toBe(true);
  });

  it('accepts a recurrence rule, null or none', () => {
    const task = { type: 'task', title: 'a', status: 'next', due: '2026-10-26' };
    expect(TaskSchema.safeParse({ ...task, recurrence: 'every monday' }).success).toBe(true);
    expect(TaskSchema.safeParse({ ...task, recurrence: null }).success).toBe(true);
    expect(TaskSchema.safeParse(task).success).toBe(true);
    expect(TaskSchema.safeParse({ ...task, recurrence: '' }).success).toBe(false);
  });

  it.each([
    ['unknown status', { type: 'task', title: 'a', status: 'today' }],
    ['empty title', { type: 'task', title: '', status: 'next' }],
    ['missing status', { type: 'task', title: 'a' }],
    ['date-time without offset', { type: 'task', title: 'a', status: 'next', due: '2026-10-16T18:00:00' }],
    ['tags not an array', { type: 'task', title: 'a', status: 'next', tags: 'accounting' }],
    ['wrong type', { type: 'schedule', title: 'a', status: 'next' }],
  ])('rejects %s', (_label, input) => {
    expect(TaskSchema.safeParse(input).success).toBe(false);
  });
});

describe('TaskCreateInputSchema', () => {
  it('accepts the spec §9 shape', () => {
    const result = TaskCreateInputSchema.safeParse({
      title: '経費精算',
      status: 'next',
      due: '2026-10-16',
      area: 'work',
      tags: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an offset date-time due', () => {
    expect(TaskCreateInputSchema.safeParse({ title: 'a', due: '2026-10-16T18:00:00+09:00' }).success).toBe(true);
  });

  it.each([
    ['project_ref (not an input in Phase 2)', { title: 'a', project_ref: null }],
    ['an unknown key', { title: 'a', calendar_id: 'x' }],
    ['a date-time without offset', { title: 'a', due: '2026-10-16T18:00:00' }],
    ['a reserved af- tag', { title: 'a', tags: ['accounting', 'af-next'] }],
    ['a reserved tag in another case', { title: 'a', tags: ['AF-custom'] }],
  ])('rejects %s', (_label, input) => {
    expect(TaskCreateInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a title-only input', () => {
    expect(TaskCreateInputSchema.safeParse({ title: '経費精算' }).success).toBe(true);
  });

  it('rejects creating a task as done', () => {
    expect(TaskCreateInputSchema.safeParse({ title: 'a', status: 'done' }).success).toBe(false);
  });

  it('rejects an unknown area', () => {
    expect(TaskCreateInputSchema.safeParse({ title: 'a', area: 'study' }).success).toBe(false);
  });

  describe('recurrence', () => {
    it('accepts a rule and keeps it as given', () => {
      const result = TaskCreateInputSchema.safeParse({ title: 'a', status: 'next', recurrence: ' every monday ' });
      expect(result.data?.recurrence).toBe(' every monday ');
    });

    it('accepts due: null with a rule, since it means no due on create', () => {
      expect(TaskCreateInputSchema.safeParse({ title: 'a', recurrence: 'every day', due: null }).success).toBe(true);
    });

    it('rejects a due together with a rule', () => {
      const result = TaskCreateInputSchema.safeParse({ title: 'a', recurrence: 'every day', due: '2026-11-01' });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['recurrence']);
    });

    it.each([
      ['an empty rule', ''],
      ['a blank rule', '   '],
      ['a number', 123],
      ['null', null],
    ])('rejects %s', (_label, recurrence) => {
      expect(TaskCreateInputSchema.safeParse({ title: 'a', recurrence }).success).toBe(false);
    });
  });
});

describe('TaskListFilterSchema', () => {
  it('accepts every filter', () => {
    const result = TaskListFilterSchema.safeParse({
      status: ['next', 'inbox'],
      area: 'work',
      due_before: '2026-10-31',
      due_after: '2026-10-01T00:00:00+09:00',
      tags: ['accounting'],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['done status', { status: ['done'] }],
    ['project_ref', { project_ref: 'github:x/y' }],
    ['a null due bound', { due_before: null }],
  ])('rejects %s', (_label, input) => {
    expect(TaskListFilterSchema.safeParse(input).success).toBe(false);
  });

  it('accepts an empty filter', () => {
    expect(TaskListFilterSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a non-array status', () => {
    expect(TaskListFilterSchema.safeParse({ status: 'next' }).success).toBe(false);
  });
});

describe('TaskUpdateInputSchema', () => {
  it.each([
    ['title', { title: '新しいタイトル' }],
    ['status', { status: 'waiting' }],
    ['due', { due: '2026-10-20' }],
    ['due cleared', { due: null }],
    ['area cleared', { area: null }],
    ['tags cleared', { tags: [] }],
    ['recurrence', { recurrence: 'every day' }],
    ['recurrence cleared', { recurrence: null }],
  ])('accepts a single field: %s', (_label, fields) => {
    expect(TaskUpdateInputSchema.safeParse({ id: 'todoist:1', ...fields }).success).toBe(true);
  });

  it('rejects an update without any field', () => {
    const result = TaskUpdateInputSchema.safeParse({ id: 'todoist:1' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('At least one of');
    expect(result.error?.issues[0]?.message).toContain('recurrence');
  });

  it.each([
    ['due', { due: '2026-11-01' }],
    ['due cleared', { due: null }],
    ['title', { title: 'a' }],
    ['status', { status: 'next' }],
    ['area cleared', { area: null }],
    ['tags cleared', { tags: [] }],
  ])('rejects recurrence together with %s', (_label, fields) => {
    for (const recurrence of ['every day', null]) {
      const result = TaskUpdateInputSchema.safeParse({ id: 'todoist:1', recurrence, ...fields });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['recurrence']);
      expect(result.error?.issues[0]?.message).toContain('on its own');
    }
  });

  it('still accepts due together with other fields', () => {
    expect(TaskUpdateInputSchema.safeParse({ id: 'todoist:1', due: '2026-11-01', title: 'a', status: 'next' }).success).toBe(true);
  });

  it.each([
    ['status done', { id: 'todoist:1', status: 'done' }],
    ['empty title', { id: 'todoist:1', title: '' }],
    ['missing id', { title: 'a' }],
    ['a reserved tag', { id: 'todoist:1', tags: ['af-area-work'] }],
    ['an unknown key', { id: 'todoist:1', title: 'a', project_ref: 'x' }],
    ['an empty recurrence', { id: 'todoist:1', recurrence: '' }],
    ['a blank recurrence', { id: 'todoist:1', recurrence: '  ' }],
    ['a non-string recurrence', { id: 'todoist:1', recurrence: true }],
  ])('rejects %s', (_label, input) => {
    expect(TaskUpdateInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('TaskIdInputSchema', () => {
  it('requires a non-empty id', () => {
    expect(TaskIdInputSchema.safeParse({ id: 'todoist:1' }).success).toBe(true);
    expect(TaskIdInputSchema.safeParse({ id: '' }).success).toBe(false);
    expect(TaskIdInputSchema.safeParse({}).success).toBe(false);
  });
});
