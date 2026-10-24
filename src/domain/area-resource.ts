import { z } from 'zod';
import { NonBlankSchema } from './common.js';

export const AreaResourceSourceSchema = z.enum(['notion']);
export type AreaResourceSource = z.infer<typeof AreaResourceSourceSchema>;

/**
 * A PARA area: a long-lived area of responsibility whose page is a table of contents linking to
 * related pages, knowledge and projects. Not the work / personal `Area` used by tasks and knowledge.
 * Same fields as a project, so that areas and projects read alike.
 */
export const AreaResourceSchema = z.object({
  id: z.string().min(1),
  type: z.literal('area'),
  title: z.string().min(1),
  source: AreaResourceSourceSchema,
  external_ref: z.string().min(1),
});
export type AreaResource = z.infer<typeof AreaResourceSchema>;

/** Input of `area_list`. `{}` lists every area. */
export const AreaListFilterSchema = z.strictObject({
  /** Case-insensitive substring of the title. */
  query: NonBlankSchema.optional(),
});
export type AreaListFilter = z.infer<typeof AreaListFilterSchema>;

/** Input of `area_get`: an exact id (`notion:<page-id>`) from `area_list`. */
export const AreaGetInputSchema = z.strictObject({ id: z.string().min(1) });
export type AreaGetInput = z.infer<typeof AreaGetInputSchema>;

/** `area_get` result: the area and its table of contents as Markdown-like text. */
export const AreaGetResultSchema = z.object({
  area: AreaResourceSchema,
  content: z.string(),
});
export type AreaGetResult = z.infer<typeof AreaGetResultSchema>;
