import { z } from 'zod';
import { AreaSchema, DateOrDateTimeSchema, NonBlankSchema, OptionalMetadataShape, TagsSchema } from './common.js';

export const TaskStatusSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Statuses a task can be created, listed or updated with. `done` is reached only via `task_complete`. */
export const ActiveTaskStatusSchema = TaskStatusSchema.exclude(['done']);
export type ActiveTaskStatus = z.infer<typeof ActiveTaskStatusSchema>;

/** Tags starting with this prefix (case-insensitive) are reserved for AI Foundation's own labels. */
export const RESERVED_TAG_PREFIX = 'af-';

export function isReservedTag(tag: string): boolean {
  return tag.toLowerCase().startsWith(RESERVED_TAG_PREFIX);
}

/** A Todoist recurring rule, e.g. "every monday" or "every! 3 days". Stored as given. */
const RecurrenceSchema = NonBlankSchema;

const TaskTagsInputSchema = TagsSchema.refine((tags) => !tags.some(isReservedTag), {
  message: `tags must not start with "${RESERVED_TAG_PREFIX}" (reserved for AI Foundation)`,
});

/** An executable action. Source of Truth: Todoist (spec §5.2). */
export const TaskSchema = z.object({
  ...OptionalMetadataShape,
  type: z.literal('task'),
  title: z.string().min(1),
  status: TaskStatusSchema,
  /** Deadline, not working time. Date-only is allowed. */
  due: DateOrDateTimeSchema.nullable().optional(),
  area: AreaSchema.nullable().optional(),
  project_ref: z.string().min(1).nullable().optional(),
  tags: TagsSchema.optional(),
  /** The recurring rule as Todoist holds it; null when the task does not recur. `due` is the next occurrence. */
  recurrence: z.string().min(1).nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/** Input of `task_create`. Omitted status means `inbox`. */
export const TaskCreateInputSchema = z
  .strictObject({
    title: z.string().min(1),
    status: ActiveTaskStatusSchema.optional(),
    due: DateOrDateTimeSchema.nullable().optional(),
    area: AreaSchema.nullable().optional(),
    tags: TaskTagsInputSchema.optional(),
    /** Makes the task recurring; Todoist sets the due from it. */
    recurrence: RecurrenceSchema.optional(),
  })
  .refine((input) => input.recurrence === undefined || input.due == null, {
    message: 'due and recurrence cannot be specified together; Todoist sets the due from the recurrence',
    path: ['recurrence'],
  });
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

/** Input of `task_list`. Every field narrows the result; an empty filter returns all open tasks. */
export const TaskListFilterSchema = z.strictObject({
  /** Matches any of the given statuses. */
  status: z.array(ActiveTaskStatusSchema).optional(),
  area: AreaSchema.optional(),
  /** Inclusive. Tasks without a due are excluded when set. */
  due_before: DateOrDateTimeSchema.optional(),
  /** Inclusive. Tasks without a due are excluded when set. */
  due_after: DateOrDateTimeSchema.optional(),
  /** Matches tasks that have all of the given tags. */
  tags: TagsSchema.optional(),
});
export type TaskListFilter = z.infer<typeof TaskListFilterSchema>;

const TASK_UPDATE_FIELDS = ['title', 'status', 'due', 'recurrence', 'area', 'tags'] as const;

/**
 * Input of `task_update`. Only the given fields change; `null` clears `due` / `area`.
 * `recurrence` must be the only change, so a rule Todoist does not accept never leaves other fields updated.
 */
export const TaskUpdateInputSchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    status: ActiveTaskStatusSchema.optional(),
    due: DateOrDateTimeSchema.nullable().optional(),
    area: AreaSchema.nullable().optional(),
    /** Replaces the task's tags. AI Foundation's own labels are kept. */
    tags: TaskTagsInputSchema.optional(),
    /** Sets or changes the recurring rule; `null` removes the rule together with the due. */
    recurrence: RecurrenceSchema.nullable().optional(),
  })
  .refine((input) => TASK_UPDATE_FIELDS.some((field) => input[field] !== undefined), {
    message: `At least one of ${TASK_UPDATE_FIELDS.join(', ')} must be specified`,
  })
  .refine(
    (input) =>
      input.recurrence === undefined ||
      TASK_UPDATE_FIELDS.every((field) => field === 'recurrence' || input[field] === undefined),
    {
      message: 'recurrence must be updated on its own; change title / status / due / area / tags in a separate task_update',
      path: ['recurrence'],
    },
  );
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

/** Input of `task_complete`. */
export const TaskIdInputSchema = z.strictObject({
  id: z.string().min(1),
});
export type TaskIdInput = z.infer<typeof TaskIdInputSchema>;
