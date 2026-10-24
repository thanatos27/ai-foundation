import { z } from 'zod';
import { addHoursKeepingOffset } from '../shared/datetime.js';
import {
  DateOrDateTimeSchema,
  OptionalMetadataShape,
  TagsSchema,
  endNotBeforeStart,
  isDateOnly,
  sameDateKind,
} from './common.js';

const END_BEFORE_START = { message: 'end must not be earlier than start', path: ['end'] };
const MIXED_DATE_KIND = { message: 'start and end must both be dates or both be date-times', path: ['end'] };

/**
 * A writable calendar's name in config and tool input, e.g. `personal`. Never a calendar ID:
 * it has no `@`, so the two cannot be confused.
 */
export const CalendarAliasSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, {
  message: 'must be lowercase letters, digits, "_" or "-", starting with a letter (max 32)',
});

/** Free-form text kept exactly as given (not trimmed); may be HTML. Clearing is `null`, not `''`. */
const ScheduleTextSchema = z.string().min(1);

/**
 * An event or time block at a specific time. Source of Truth: Google Calendar (spec §5.3).
 * Date-only `start` / `end` is an all-day event; `end` is the last day, inclusive.
 */
export const ScheduleSchema = z
  .object({
    ...OptionalMetadataShape,
    type: z.literal('schedule'),
    /** The configured alias of a writable calendar (`personal`); otherwise the provider's calendar ID. */
    calendar: z.string().min(1),
    title: z.string().min(1),
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema.nullable().optional(),
    /** The source's free-form body as stored (may be HTML); null when empty. */
    description: z.string().nullable(),
    location: z.string().nullable(),
    tags: TagsSchema.optional(),
  })
  .refine(sameDateKind, MIXED_DATE_KIND)
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * Input of `schedule_create`.
 * Date-time start: a timed event, one hour long when `end` is omitted.
 * Date start: an all-day event through `end` (inclusive), a single day when `end` is omitted.
 * `calendar` is a writable calendar alias (the connector checks it against config); omitted: the default.
 * `description` / `location`: `null` is the same as omitted.
 */
export const ScheduleCreateInputSchema = z
  .strictObject({
    title: z.string().min(1),
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema.nullable().optional(),
    calendar: z.string().min(1).optional(),
    description: ScheduleTextSchema.nullable().optional(),
    location: ScheduleTextSchema.nullable().optional(),
  })
  .refine(sameDateKind, MIXED_DATE_KIND)
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInputSchema>;

/**
 * Input of `schedule_list`: events overlapping [start, end]. A date `end` includes that whole day.
 * Dates are resolved in the configured time zone by the connector, which also checks the order
 * when dates and date-times are mixed.
 * `calendar`: a writable calendar alias or a readable calendar's ID (as in `Schedule.calendar`);
 * omitted: every calendar the user can read.
 */
export const ScheduleListFilterSchema = z
  .strictObject({
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema,
    calendar: z.string().min(1).optional(),
  })
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
export type ScheduleListFilter = z.infer<typeof ScheduleListFilterSchema>;

const SCHEDULE_UPDATE_FIELDS = ['title', 'start', 'end', 'description', 'location'] as const;

/**
 * Input of `schedule_update`. Omitted fields are kept; `description` / `location: null` clears them.
 * Only `start` or only `end` keeps the other one; the connector checks the pair against the event.
 * The calendar never changes (no `calendar` field).
 */
export const ScheduleUpdateInputSchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    start: DateOrDateTimeSchema.optional(),
    end: DateOrDateTimeSchema.optional(),
    description: ScheduleTextSchema.nullable().optional(),
    location: ScheduleTextSchema.nullable().optional(),
  })
  .refine((input) => SCHEDULE_UPDATE_FIELDS.some((field) => input[field] !== undefined), {
    message: `At least one of ${SCHEDULE_UPDATE_FIELDS.join(', ')} must be specified`,
  })
  .refine((value) => value.start === undefined || sameDateKind({ start: value.start, end: value.end }), MIXED_DATE_KIND)
  .refine(
    (value) =>
      value.start === undefined ||
      !sameDateKind({ start: value.start, end: value.end }) ||
      endNotBeforeStart({ start: value.start, end: value.end }),
    END_BEFORE_START,
  );
export type ScheduleUpdateInput = z.infer<typeof ScheduleUpdateInputSchema>;

/** `schedule_create` input with its provider-independent defaults applied. */
export type NormalizedScheduleCreate = { title: string; description: string | null; location: string | null } & (
  | { kind: 'timed'; start: string; end: string }
  | { kind: 'all_day'; startDate: string; endDate: string }
);

/** Applies the defaults: timed events last one hour, all-day events last one day. */
export function normalizeScheduleCreateInput(input: ScheduleCreateInput): NormalizedScheduleCreate {
  const text = { title: input.title, description: input.description ?? null, location: input.location ?? null };
  if (isDateOnly(input.start)) {
    return { kind: 'all_day', ...text, startDate: input.start, endDate: input.end ?? input.start };
  }
  return { kind: 'timed', ...text, start: input.start, end: input.end ?? addHoursKeepingOffset(input.start, 1) };
}
