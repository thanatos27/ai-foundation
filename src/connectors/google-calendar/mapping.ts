import type { NormalizedScheduleCreate, Schedule, ScheduleListFilter, ScheduleUpdateInput } from '../../domain/index.js';
import { endNotBeforeStart, isDateOnly } from '../../domain/index.js';
import { InputValidationError, ProviderApiError } from '../../errors.js';
import { addDays, startOfDay } from '../../shared/datetime.js';
import type { GoogleEvent } from './client.js';

/**
 * Domain → Google event. A timed event keeps the input offset and sends no `timeZone`.
 * An all-day event's end becomes exclusive, as Google expects. Description and location are sent
 * as given, and only when set.
 */
export function toGoogleEvent(schedule: NormalizedScheduleCreate): GoogleEvent {
  const text: GoogleEvent = {
    summary: schedule.title,
    ...(schedule.description !== null && { description: schedule.description }),
    ...(schedule.location !== null && { location: schedule.location }),
  };
  if (schedule.kind === 'timed') {
    return { ...text, start: { dateTime: schedule.start }, end: { dateTime: schedule.end } };
  }
  return { ...text, start: { date: schedule.startDate }, end: { date: addDays(schedule.endDate, 1) } };
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

const ID_PREFIX = 'google_calendar:';

export const toScheduleId = (calendarId: string, eventId: string): string => `${ID_PREFIX}${calendarId}:${eventId}`;

/**
 * Schedule id → calendar and event IDs. The event ID follows the last `:` (event IDs never contain
 * one); expanded recurring instances add `_<date>` or `_<date-time>Z`.
 */
export function parseScheduleId(id: string): { calendarId: string; eventId: string } {
  const rest = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : '';
  const separator = rest.lastIndexOf(':');
  const calendarId = rest.slice(0, Math.max(separator, 0));
  const eventId = rest.slice(separator + 1);
  if (separator <= 0 || !/^\S+$/.test(calendarId) || !/^[A-Za-z0-9_]+$/.test(eventId)) {
    throw new InputValidationError(`schedule id must look like "google_calendar:<calendar-id>:<event-id>", got "${id}"`);
  }
  return { calendarId, eventId };
}

/**
 * Google event → domain schedule, or `undefined` for an event without a start.
 * An all-day event's exclusive end becomes the inclusive last day. `calendar` is the calendar's
 * name in the output (its alias when writable). Description and location are returned exactly as
 * stored; an empty one is `null`.
 */
export function toSchedule(event: GoogleEvent, calendarId: string, calendar: string): Schedule | undefined {
  const start = event.start?.dateTime ?? event.start?.date;
  if (!start) return undefined;
  const end = event.end?.dateTime ?? (event.end?.date ? addDays(event.end.date, -1) : null);
  return {
    id: toScheduleId(calendarId, event.id ?? ''),
    source: 'google_calendar',
    external_ref: event.htmlLink ?? null,
    type: 'schedule',
    calendar,
    title: event.summary?.trim() || '(No title)',
    start,
    // An all-day end can never precede its start; guard against malformed events anyway.
    end: end !== null && isDateOnly(start) && end < start ? start : end,
    description: event.description || null,
    location: event.location || null,
  };
}

/**
 * `schedule_update` input → events.patch body for `current`. Only the given fields are sent, and of
 * start / end only the given end points: the other one stays as Google Calendar has it. With only
 * one end point, it must keep the event's kind (timed / all-day) and its order with the other one;
 * `current` is read for that check only. Switching kinds needs both, and nulls the other form.
 */
export function toEventPatch(input: ScheduleUpdateInput, current: GoogleEvent): GoogleEvent {
  const patch: GoogleEvent = {};
  if (input.title !== undefined) patch.summary = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.start === undefined && input.end === undefined) return patch;

  const currentStart = current.start?.dateTime ?? current.start?.date;
  const currentEnd = current.end?.dateTime ?? (current.end?.date ? addDays(current.end.date, -1) : undefined);
  if (!currentStart || !currentEnd) {
    throw new ProviderApiError('Google Calendar', 'the event to update has no start or end');
  }
  const start = input.start ?? currentStart;
  const end = input.end ?? currentEnd;
  const allDay = isDateOnly(start);
  const switching = allDay !== isDateOnly(currentStart);

  if (input.start === undefined || input.end === undefined) {
    if (switching || allDay !== isDateOnly(end)) {
      throw new InputValidationError('give both start and end to switch between a timed and an all-day event');
    }
    if (!endNotBeforeStart({ start, end })) {
      throw new InputValidationError(
        input.start !== undefined
          ? `start ${start} would be after the event's end ${end}; give end as well`
          : `end ${end} would be earlier than the event's start ${start}; give start as well`,
      );
    }
  }

  const point = (value: string, isEnd: boolean): GoogleEvent['start'] =>
    allDay
      ? { date: isEnd ? addDays(value, 1) : value, ...(switching && { dateTime: null }) }
      : { dateTime: value, ...(switching && { date: null }) };
  if (input.start !== undefined) patch.start = point(start, false);
  if (input.end !== undefined) patch.end = point(end, true);
  return patch;
}

/** Sort key: all-day events start at the beginning of their day in `timeZone`. */
export function startInstant(schedule: Schedule, timeZone: string): number {
  return isDateOnly(schedule.start) ? startOfDay(schedule.start, timeZone) : Date.parse(schedule.start);
}
