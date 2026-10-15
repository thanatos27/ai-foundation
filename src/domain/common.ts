import { z } from 'zod';

export const AreaSchema = z.enum(['work', 'personal']);
export type Area = z.infer<typeof AreaSchema>;

export const TagsSchema = z.array(z.string().min(1));

/** Calendar date without time, e.g. `2026-10-16`. */
export const DateSchema = z.iso.date();

/** ISO 8601 date-time with an explicit UTC offset (or `Z`), e.g. `2026-10-18T20:00:00+09:00`. */
export const DateTimeSchema = z.iso.datetime({ offset: true });

export const DateOrDateTimeSchema = z.union([DateSchema, DateTimeSchema]);

/**
 * Common metadata (spec §5.1) that entities carry only when needed.
 * Entities whose spec makes a field mandatory (e.g. Knowledge.source) override it.
 */
export const OptionalMetadataShape = {
  id: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  external_ref: z.string().min(1).nullable().optional(),
};

/**
 * Rejects `end` earlier than `start`. Both must be the same kind (see `sameDateKind`): offset
 * date-times compare as instants, and dates compare as UTC midnights, so Date.parse is unambiguous.
 */
export function endNotBeforeStart(value: { start: string; end?: string | null | undefined }): boolean {
  if (value.end == null) return true;
  return Date.parse(value.end) >= Date.parse(value.start);
}

/** True for a calendar date without time (`YYYY-MM-DD`). */
export function isDateOnly(value: string): boolean {
  return DateSchema.safeParse(value).success;
}

/** Rejects a `start` / `end` pair that mixes a date with a date-time. */
export function sameDateKind(value: { start: string; end?: string | null | undefined }): boolean {
  if (value.end == null) return true;
  return isDateOnly(value.start) === isDateOnly(value.end);
}
