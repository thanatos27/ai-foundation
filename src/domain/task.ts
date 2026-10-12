import { z } from 'zod';
import { AreaSchema, DateOrDateTimeSchema, OptionalMetadataShape, TagsSchema } from './common.js';

export const TaskStatusSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

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
});
export type Task = z.infer<typeof TaskSchema>;

/** Input of `task_create` (spec §9). A new task cannot be created as `done`. */
export const TaskCreateInputSchema = z.object({
  title: z.string().min(1),
  status: TaskStatusSchema.exclude(['done']).optional(),
  due: DateOrDateTimeSchema.nullable().optional(),
  area: AreaSchema.nullable().optional(),
  project_ref: z.string().min(1).nullable().optional(),
  tags: TagsSchema.optional(),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

/** Input of `task_list` (spec §9). */
export const TaskListFilterSchema = z.object({
  status: z.array(TaskStatusSchema).optional(),
  area: AreaSchema.optional(),
  due_before: DateOrDateTimeSchema.nullable().optional(),
  due_after: DateOrDateTimeSchema.nullable().optional(),
  project_ref: z.string().min(1).nullable().optional(),
  tags: TagsSchema.optional(),
});
export type TaskListFilter = z.infer<typeof TaskListFilterSchema>;
