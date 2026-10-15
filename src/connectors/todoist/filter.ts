import type { Task, TaskListFilter } from '../../domain/index.js';
import { isDateOnly } from '../../domain/index.js';
import { localDateOf } from '../../shared/datetime.js';

/**
 * Compares a due with a bound. Two date-times compare as instants; when either is a date,
 * both are compared as calendar dates in `timeZone`.
 */
function compareDue(due: string, bound: string, timeZone: string): number {
  if (!isDateOnly(due) && !isDateOnly(bound)) return Date.parse(due) - Date.parse(bound);
  const day = (value: string) => (isDateOnly(value) ? value : localDateOf(Date.parse(value), timeZone));
  return day(due).localeCompare(day(bound));
}

/** Applies a `task_list` filter: status OR, tags AND, due bounds inclusive. */
export function matchesFilter(task: Task, filter: TaskListFilter, timeZone: string): boolean {
  if (filter.status && filter.status.length > 0 && !filter.status.some((status) => status === task.status)) {
    return false;
  }
  if (filter.area && task.area !== filter.area) return false;
  if (filter.tags && !filter.tags.every((tag) => task.tags?.includes(tag))) return false;
  if (filter.due_before !== undefined || filter.due_after !== undefined) {
    if (!task.due) return false;
    if (filter.due_before !== undefined && compareDue(task.due, filter.due_before, timeZone) > 0) return false;
    if (filter.due_after !== undefined && compareDue(task.due, filter.due_after, timeZone) < 0) return false;
  }
  return true;
}
