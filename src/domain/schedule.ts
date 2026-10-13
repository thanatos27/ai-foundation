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
 * An event or time block at a specific time. Source of Truth: Google Calendar (spec §5.3).
 * Date-only `start` / `end` is an all-day event; `end` is the last day, inclusive.
 */
export const ScheduleSchema = z
  .object({
    ...OptionalMetadataShape,
    type: z.literal('schedule'),
    title: z.string().min(1),
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema.nullable().optional(),
    tags: TagsSchema.optional(),
  })
  .refine(sameDateKind, MIXED_DATE_KIND)
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * Input of `schedule_create`.
 * Date-time start: a timed event, one hour long when `end` is omitted.
 * Date start: an all-day event through `end` (inclusive), a single day when `end` is omitted.
 */
export const ScheduleCreateInputSchema = z
  .strictObject({
    title: z.string().min(1),
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema.nullable().optional(),
  })
  .refine(sameDateKind, MIXED_DATE_KIND)
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInputSchema>;

/**
 * Input of `schedule_list`: events overlapping [start, end]. A date `end` includes that whole day.
 * Dates are resolved in the configured time zone by the connector, which also checks the order
 * when dates and date-times are mixed.
 */
export const ScheduleListFilterSchema = z
  .strictObject({
    start: DateOrDateTimeSchema,
    end: DateOrDateTimeSchema,
  })
  .refine((value) => !sameDateKind(value) || endNotBeforeStart(value), END_BEFORE_START);
export type ScheduleListFilter = z.infer<typeof ScheduleListFilterSchema>;

/** `schedule_create` input with its provider-independent defaults applied. */
export type NormalizedScheduleCreate =
  | { kind: 'timed'; title: string; start: string; end: string }
  | { kind: 'all_day'; title: string; startDate: string; endDate: string };

/** Applies the defaults: timed events last one hour, all-day events last one day. */
export function normalizeScheduleCreateInput(input: ScheduleCreateInput): NormalizedScheduleCreate {
  if (isDateOnly(input.start)) {
    return { kind: 'all_day', title: input.title, startDate: input.start, endDate: input.end ?? input.start };
  }
  return {
    kind: 'timed',
    title: input.title,
    start: input.start,
    end: input.end ?? addHoursKeepingOffset(input.start, 1),
  };
}
