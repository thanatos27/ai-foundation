import { describe, expect, it } from 'vitest';
import { TaskCreateInputSchema, TaskListFilterSchema, TaskSchema } from '../../src/domain/index.js';

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
      project_ref: null,
      tags: [],
    });
    expect(result.success).toBe(true);
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
});

describe('TaskListFilterSchema', () => {
  it('accepts the spec §9 example', () => {
    const result = TaskListFilterSchema.safeParse({
      status: ['next'],
      area: 'work',
      due_before: null,
      due_after: null,
      project_ref: null,
      tags: ['accounting'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty filter', () => {
    expect(TaskListFilterSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a non-array status', () => {
    expect(TaskListFilterSchema.safeParse({ status: 'next' }).success).toBe(false);
  });
});
