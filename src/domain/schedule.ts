import { z } from 'zod';
import { DateTimeSchema, OptionalMetadataShape, TagsSchema, endNotBeforeStart } from './common.js';

const END_BEFORE_START = { message: 'end must not be earlier than start', path: ['end'] };

/** An event or time block at a specific time. Source of Truth: Google Calendar (spec §5.3). */
export const ScheduleSchema = z
  .object({
    ...OptionalMetadataShape,
    type: z.literal('schedule'),
    title: z.string().min(1),
    start: DateTimeSchema,
    end: DateTimeSchema.nullable().optional(),
    related_task: z.string().min(1).nullable().optional(),
    tags: TagsSchema.optional(),
  })
  .refine(endNotBeforeStart, END_BEFORE_START);
export type Schedule = z.infer<typeof ScheduleSchema>;

/** Input of `schedule_create` (spec §9). */
export const ScheduleCreateInputSchema = z
  .object({
    title: z.string().min(1),
    start: DateTimeSchema,
    end: DateTimeSchema.nullable().optional(),
    related_task: z.string().min(1).nullable().optional(),
  })
  .refine(endNotBeforeStart, END_BEFORE_START);
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInputSchema>;
