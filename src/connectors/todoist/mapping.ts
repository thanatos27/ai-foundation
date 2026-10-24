import type { ActiveTaskStatus, Area, Task } from '../../domain/index.js';
import { isDateOnly, isReservedTag } from '../../domain/index.js';
import { InputValidationError } from '../../errors.js';
import { formatInTimeZone, toUtcDateTime, zonedDateTimeToInstant } from '../../shared/datetime.js';
import type { TodoistTask } from './client.js';

/**
 * AI Foundation's own Todoist labels. Every label starting with `af-` belongs to AI Foundation
 * and is never exposed as a tag; only the ones below carry meaning today.
 * Listed in precedence order, used when a task carries more than one of a kind.
 */
export const STATUS_LABELS = { next: 'af-next', waiting: 'af-waiting', someday: 'af-someday' } as const;
export const AREA_LABELS = { work: 'af-area-work', personal: 'af-area-personal' } as const;

const ID_PREFIX = 'todoist:';

export const toTaskId = (todoistId: string): string => `${ID_PREFIX}${todoistId}`;

/** `todoist:<id>` → `<id>`. */
export function parseTaskId(id: string): string {
  const todoistId = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : '';
  if (!/^[A-Za-z0-9_-]+$/.test(todoistId)) {
    throw new InputValidationError(`task id must look like "todoist:<task-id>", got "${id}"`);
  }
  return todoistId;
}

const lower = (label: string) => label.toLowerCase();

function labelOf<K extends string>(labels: string[], mapping: Record<K, string>): K | undefined {
  const present = new Set(labels.map(lower));
  return (Object.keys(mapping) as K[]).find((key) => present.has(mapping[key]));
}

const isStatusLabel = (label: string) => Object.values<string>(STATUS_LABELS).includes(lower(label));
const isAreaLabel = (label: string) => Object.values<string>(AREA_LABELS).includes(lower(label));

/** Labels for a new task. */
export function labelsFor(fields: { status?: ActiveTaskStatus; area?: Area | null; tags?: string[] }): string[] {
  return [
    ...(fields.status && fields.status !== 'inbox' ? [STATUS_LABELS[fields.status]] : []),
    ...(fields.area ? [AREA_LABELS[fields.area]] : []),
    ...(fields.tags ?? []),
  ];
}

/**
 * Labels after an update. Only the kinds being changed are replaced: status and area swap their
 * own label, tags replace every non-`af-` label. Other `af-` labels are always kept.
 */
export function updatedLabels(
  current: string[],
  changes: { status?: ActiveTaskStatus; area?: Area | null; tags?: string[] },
): string[] {
  let labels = current;
  if (changes.status !== undefined) {
    labels = [...labels.filter((l) => !isStatusLabel(l)), ...labelsFor({ status: changes.status })];
  }
  if (changes.area !== undefined) {
    labels = [...labels.filter((l) => !isAreaLabel(l)), ...labelsFor({ area: changes.area })];
  }
  if (changes.tags !== undefined) {
    labels = [...labels.filter(isReservedTag), ...changes.tags];
  }
  return labels;
}

/** Due fields of an add / update request: a date, or a date-time sent as UTC. */
export function dueArgs(due: string): { dueDate: string } | { dueDatetime: string } {
  return isDateOnly(due) ? { dueDate: due } : { dueDatetime: toUtcDateTime(due) };
}

/** Update request field that removes the due (the SDK's alias for `"no date"`). */
export const CLEAR_DUE = { dueString: null } as const;

/** Language of every recurrence AI Foundation sends; rules are written in English. */
export const RECURRENCE_LANG = 'en';

/** Add / update request fields that set a recurring rule. */
export function recurrenceArgs(rule: string): { dueString: string; dueLang: string } {
  return { dueString: rule, dueLang: RECURRENCE_LANG };
}

/** Todoist due → recurrence: the rule text of a recurring due, else null. */
export function recurrenceOf(due: TodoistTask['due']): string | null {
  return due?.isRecurring && due.string ? due.string : null;
}

const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Todoist due → `YYYY-MM-DD` or an offset date-time. A time is shown in the due's own time zone
 * (or `timeZone` when it has none); a floating time is interpreted in that zone.
 */
export function dueOf(due: TodoistTask['due'], timeZone: string): string | null {
  if (!due) return null;
  const value = due.datetime ?? due.date;
  if (isDateOnly(value)) return value;
  const zone = due.timezone ?? timeZone;
  const instant = EXPLICIT_OFFSET.test(value) ? Date.parse(value) : zonedDateTimeToInstant(value, zone);
  return formatInTimeZone(instant, zone);
}

/**
 * Update request fields that put back `previous`, the due read before a failed change: the same
 * rule for a recurring due (Todoist may recalculate its next date), the same date / time for a
 * one-off due, or no due.
 */
export function restoreDueArgs(
  previous: TodoistTask['due'],
  timeZone: string,
): typeof CLEAR_DUE | { dueString: string; dueLang: string } | ReturnType<typeof dueArgs> {
  if (!previous) return CLEAR_DUE;
  if (previous.isRecurring) return { dueString: previous.string, dueLang: previous.lang ?? RECURRENCE_LANG };
  return dueArgs(dueOf(previous, timeZone)!);
}

/** Todoist task → domain task. `status` overrides the label-derived one (e.g. `done`). */
export function toTask(task: TodoistTask, timeZone: string, status?: Task['status']): Task {
  return {
    id: toTaskId(task.id),
    source: 'todoist',
    external_ref: `https://app.todoist.com/app/task/${task.id}`,
    type: 'task',
    title: task.content,
    status: status ?? labelOf(task.labels, STATUS_LABELS) ?? 'inbox',
    due: dueOf(task.due, timeZone),
    area: labelOf(task.labels, AREA_LABELS) ?? null,
    project_ref: null,
    tags: task.labels.filter((label) => !isReservedTag(label)),
    recurrence: recurrenceOf(task.due),
  };
}
