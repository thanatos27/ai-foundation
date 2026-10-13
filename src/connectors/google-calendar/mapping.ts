import type { NormalizedScheduleCreate, Schedule, ScheduleListFilter } from '../../domain/index.js';
import { isDateOnly } from '../../domain/index.js';
import { InputValidationError } from '../../errors.js';
import { addDays, startOfDay } from '../../shared/datetime.js';
import type { GoogleEvent } from './client.js';

/**
 * Domain → Google event. A timed event keeps the input offset and sends no `timeZone`.
 * An all-day event's end becomes exclusive, as Google expects.
 */
export function toGoogleEvent(schedule: NormalizedScheduleCreate): GoogleEvent {
  if (schedule.kind === 'timed') {
    return { summary: schedule.title, start: { dateTime: schedule.start }, end: { dateTime: schedule.end } };
  }
  return {
    summary: schedule.title,
    start: { date: schedule.startDate },
    end: { date: addDays(schedule.endDate, 1) },
  };
}

/** `schedule_list` period → `timeMin` / `timeMax`. A date end covers that whole day in `timeZone`. */
export function toTimeRange(filter: ScheduleListFilter, timeZone: string): { timeMin: string; timeMax: string } {
  const timeMin = isDateOnly(filter.start) ? new Date(startOfDay(filter.start, timeZone)).toISOString() : filter.start;
  const timeMax = isDateOnly(filter.end)
    ? new Date(startOfDay(addDays(filter.end, 1), timeZone)).toISOString()
    : filter.end;
  if (Date.parse(timeMax) < Date.parse(timeMin)) {
    throw new InputValidationError(`end (${filter.end}) is earlier than start (${filter.start}) in ${timeZone}`);
  }
  return { timeMin, timeMax };
}

export const toScheduleId = (calendarId: string, eventId: string): string =>
  `google_calendar:${calendarId}:${eventId}`;

/**
 * Google event → domain schedule, or `undefined` for an event without a start.
 * An all-day event's exclusive end becomes the inclusive last day.
 */
export function toSchedule(event: GoogleEvent, calendarId: string): Schedule | undefined {
  const start = event.start?.dateTime ?? event.start?.date;
  if (!start) return undefined;
  const end = event.end?.dateTime ?? (event.end?.date ? addDays(event.end.date, -1) : null);
  return {
    id: toScheduleId(calendarId, event.id ?? ''),
    source: 'google_calendar',
    external_ref: event.htmlLink ?? null,
    type: 'schedule',
    title: event.summary?.trim() || '(No title)',
    start,
    // An all-day end can never precede its start; guard against malformed events anyway.
    end: end !== null && isDateOnly(start) && end < start ? start : end,
  };
}

/** Sort key: all-day events start at the beginning of their day in `timeZone`. */
export function startInstant(schedule: Schedule, timeZone: string): number {
  return isDateOnly(schedule.start) ? startOfDay(schedule.start, timeZone) : Date.parse(schedule.start);
}
