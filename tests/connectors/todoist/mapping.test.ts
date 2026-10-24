import { describe, expect, it } from 'vitest';
import {
  dueArgs,
  dueOf,
  labelsFor,
  parseTaskId,
  recurrenceArgs,
  recurrenceOf,
  restoreDueArgs,
  toTask,
  updatedLabels,
} from '../../../src/connectors/todoist/mapping.js';
import { InputValidationError } from '../../../src/errors.js';
import { todoistTask } from './fake-api.js';

const TZ = 'Asia/Tokyo';

describe('task id', () => {
  it('parses todoist:<id>', () => {
    expect(parseTaskId('todoist:6X7rM8997g3RQmvh')).toBe('6X7rM8997g3RQmvh');
  });

  it.each(['6X7rM8997g3RQmvh', 'todoist:', 'notion:abc', 'todoist:a/b', 'todoist:../x'])(
    'rejects %s as invalid input',
    (id) => {
      expect(() => parseTaskId(id)).toThrow(InputValidationError);
    },
  );
});

describe('labelsFor', () => {
  it.each([
    [{}, []],
    [{ status: 'inbox' as const }, []],
    [{ status: 'next' as const }, ['af-next']],
    [{ status: 'waiting' as const }, ['af-waiting']],
    [{ status: 'someday' as const }, ['af-someday']],
    [{ area: 'work' as const }, ['af-area-work']],
    [{ area: 'personal' as const }, ['af-area-personal']],
    [{ area: null }, []],
    [{ status: 'next' as const, area: 'work' as const, tags: ['accounting'] }, ['af-next', 'af-area-work', 'accounting']],
  ])('%j → %j', (fields, labels) => {
    expect(labelsFor(fields)).toEqual(labels);
  });
});

describe('updatedLabels', () => {
  const current = ['af-next', 'af-area-work', 'accounting', 'af-future', 'urgent'];

  it('swaps the status label and keeps everything else', () => {
    expect(updatedLabels(current, { status: 'waiting' })).toEqual([
      'af-area-work',
      'accounting',
      'af-future',
      'urgent',
      'af-waiting',
    ]);
  });

  it('removes the status label when moving back to inbox', () => {
    expect(updatedLabels(current, { status: 'inbox' })).not.toContain('af-next');
  });

  it('removes every status label, including duplicates left by manual edits', () => {
    expect(updatedLabels(['af-next', 'AF-WAITING', 'x'], { status: 'someday' })).toEqual(['x', 'af-someday']);
  });

  it('swaps or clears the area label', () => {
    expect(updatedLabels(current, { area: 'personal' })).toEqual([
      'af-next',
      'accounting',
      'af-future',
      'urgent',
      'af-area-personal',
    ]);
    expect(updatedLabels(current, { area: null })).not.toContain('af-area-work');
  });

  it('replaces tags but keeps every af- label, known or not', () => {
    expect(updatedLabels(current, { tags: ['new'] })).toEqual(['af-next', 'af-area-work', 'af-future', 'new']);
    expect(updatedLabels(current, { tags: [] })).toEqual(['af-next', 'af-area-work', 'af-future']);
  });

  it('applies several changes together', () => {
    expect(updatedLabels(current, { status: 'someday', area: null, tags: ['t'] })).toEqual([
      'af-future',
      'af-someday',
      't',
    ]);
  });
});

describe('due', () => {
  it('sends a date as dueDate and a date-time as UTC dueDatetime', () => {
    expect(dueArgs('2026-10-16')).toEqual({ dueDate: '2026-10-16' });
    expect(dueArgs('2026-10-16T18:00:00+09:00')).toEqual({ dueDatetime: '2026-10-16T09:00:00Z' });
  });

  it('reads no due and a date-only due', () => {
    expect(dueOf(null, TZ)).toBeNull();
    expect(dueOf({ isRecurring: false, string: 'Oct 16', date: '2026-10-16' }, TZ)).toBe('2026-10-16');
  });

  it('reads a fixed UTC time in the due time zone', () => {
    const due = { isRecurring: false, string: '', date: '2026-10-16T09:00:00Z', timezone: 'Europe/Berlin' };
    expect(dueOf(due, TZ)).toBe('2026-10-16T11:00:00+02:00');
  });

  it('reads a fixed time from datetime when present', () => {
    const due = {
      isRecurring: false,
      string: '',
      date: '2026-10-16',
      datetime: '2026-10-16T09:00:00Z',
      timezone: null,
    };
    expect(dueOf(due, TZ)).toBe('2026-10-16T18:00:00+09:00');
  });

  it('interprets a floating time inside a DST gap forward', () => {
    const due = { isRecurring: false, string: '', date: '2026-03-08T02:30:00', timezone: 'America/New_York' };
    expect(dueOf(due, TZ)).toBe('2026-03-08T03:30:00-04:00');
  });

  it('interprets a floating time in the default time zone', () => {
    const due = { isRecurring: false, string: '', date: '2026-10-16T18:00:00', timezone: null };
    expect(dueOf(due, TZ)).toBe('2026-10-16T18:00:00+09:00');
  });
});

describe('toTask', () => {
  it('maps a Todoist task to a domain task', () => {
    const task = todoistTask({
      id: '6X7rM8997g3RQmvh',
      content: '経費精算',
      labels: ['af-next', 'af-area-work', 'accounting', 'af-future'],
      due: { isRecurring: false, string: 'Oct 16', date: '2026-10-16' },
    });
    expect(toTask(task, TZ)).toEqual({
      id: 'todoist:6X7rM8997g3RQmvh',
      source: 'todoist',
      external_ref: 'https://app.todoist.com/app/task/6X7rM8997g3RQmvh',
      type: 'task',
      title: '経費精算',
      status: 'next',
      due: '2026-10-16',
      area: 'work',
      project_ref: null,
      tags: ['accounting'],
      recurrence: null,
    });
  });

  it('maps a recurring due to the next occurrence and the rule', () => {
    const task = todoistTask({ due: { isRecurring: true, string: 'every monday', date: '2026-10-26', lang: 'en' } });
    expect(toTask(task, TZ)).toMatchObject({ due: '2026-10-26', recurrence: 'every monday' });
  });

  it('has no recurrence without a due', () => {
    expect(toTask(todoistTask({ due: null }), TZ)).toMatchObject({ due: null, recurrence: null });
  });

  it('defaults to inbox with no area', () => {
    expect(toTask(todoistTask({ labels: ['x'] }), TZ)).toMatchObject({ status: 'inbox', area: null, tags: ['x'] });
  });

  it('picks one status and area deterministically when several labels are present', () => {
    const task = todoistTask({ labels: ['af-someday', 'AF-NEXT', 'af-area-personal', 'af-area-work'] });
    expect(toTask(task, TZ)).toMatchObject({ status: 'next', area: 'work', tags: [] });
  });

  it('lets the caller override the status', () => {
    expect(toTask(todoistTask({ labels: ['af-next'] }), TZ, 'done').status).toBe('done');
  });
});

describe('recurrence', () => {
  it('reads the rule of a recurring due only', () => {
    expect(recurrenceOf(null)).toBeNull();
    expect(recurrenceOf({ isRecurring: false, string: '26 Oct', date: '2026-10-26' })).toBeNull();
    expect(recurrenceOf({ isRecurring: true, string: 'every monday', date: '2026-10-26' })).toBe('every monday');
    expect(recurrenceOf({ isRecurring: true, string: '毎週月曜', date: '2026-10-26', lang: 'ja' })).toBe('毎週月曜');
  });

  it('reads a timed recurring due as Todoist returns it (time in date, no datetime)', () => {
    const due = { isRecurring: true, string: 'every day at 9am', date: '2026-10-25T09:00:00', timezone: null, lang: 'en' };
    expect(recurrenceOf(due)).toBe('every day at 9am');
    expect(dueOf(due, TZ)).toBe('2026-10-25T09:00:00+09:00');
  });

  it('treats a recurring due without rule text as no recurrence', () => {
    expect(recurrenceOf({ isRecurring: true, string: '', date: '2026-10-26' })).toBeNull();
  });

  it('sends a rule as an English dueString', () => {
    expect(recurrenceArgs('every monday')).toEqual({ dueString: 'every monday', dueLang: 'en' });
  });
});

describe('restoreDueArgs', () => {
  it('clears the due when there was none', () => {
    expect(restoreDueArgs(null, TZ)).toEqual({ dueString: null });
  });

  it('sets a recurring rule again in its own language', () => {
    expect(restoreDueArgs({ isRecurring: true, string: '毎日', date: '2026-10-25', lang: 'ja' }, TZ)).toEqual({
      dueString: '毎日',
      dueLang: 'ja',
    });
    expect(restoreDueArgs({ isRecurring: true, string: 'every day', date: '2026-10-25' }, TZ)).toEqual({
      dueString: 'every day',
      dueLang: 'en',
    });
  });

  it('puts back a one-off date or time', () => {
    expect(restoreDueArgs({ isRecurring: false, string: '1 Dec', date: '2026-12-01' }, TZ)).toEqual({
      dueDate: '2026-12-01',
    });
    const fixed = { isRecurring: false, string: '2026-11-20 09:00', date: '2026-11-20T00:00:00Z', timezone: 'Asia/Tokyo' };
    expect(restoreDueArgs(fixed, TZ)).toEqual({ dueDatetime: '2026-11-20T00:00:00Z' });
    const floating = { isRecurring: false, string: '20 Nov 18:00', date: '2026-11-20T18:00:00', timezone: null };
    expect(restoreDueArgs(floating, TZ)).toEqual({ dueDatetime: '2026-11-20T09:00:00Z' });
  });
});
