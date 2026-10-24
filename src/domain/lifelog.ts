import { z } from 'zod';
import { DateSchema, NonBlankSchema } from './common.js';

/** Where life log articles are kept. `google_drive` is added when the planned migration is implemented. */
export const LifeLogSourceSchema = z.enum(['obsidian']);
export type LifeLogSource = z.infer<typeof LifeLogSourceSchema>;

/**
 * One life log article: an occasional personal event (a trip, an outing, an event) kept as
 * free-form Markdown. Not knowledge: nothing is extracted or organized. The body is read when needed.
 */
export const LifeLogSchema = z.object({
  /** `lifelog:<file name>`: the file name in the life log directory. */
  id: z.string().min(1),
  type: z.literal('lifelog'),
  /** The day the article is about, from the file name. */
  date: DateSchema,
  /** From the file name, so it reads back the same from every tool. */
  title: z.string().min(1),
  source: LifeLogSourceSchema,
  /** Location in the source: a vault-relative path for Obsidian. */
  external_ref: z.string().min(1),
});
export type LifeLog = z.infer<typeof LifeLogSchema>;

/** Input of `lifelog_create`. `content` is the Markdown body, saved as given. */
export const LifeLogCreateInputSchema = z.strictObject({
  date: DateSchema,
  title: NonBlankSchema,
  content: NonBlankSchema,
});
export type LifeLogCreateInput = z.infer<typeof LifeLogCreateInputSchema>;

/** Input of `lifelog_get`: an exact id (`lifelog:<file name>`). */
export const LifeLogGetInputSchema = z.strictObject({ id: z.string().min(1) });
export type LifeLogGetInput = z.infer<typeof LifeLogGetInputSchema>;

/** Input of `lifelog_append`: `content` is added to the end of the article as given. */
export const LifeLogAppendInputSchema = z.strictObject({
  id: z.string().min(1),
  content: NonBlankSchema,
});
export type LifeLogAppendInput = z.infer<typeof LifeLogAppendInputSchema>;

/** `lifelog_get` result: the article and its full Markdown text. */
export const LifeLogDocumentSchema = z.object({ lifelog: LifeLogSchema, content: z.string() });
export type LifeLogDocument = z.infer<typeof LifeLogDocumentSchema>;
