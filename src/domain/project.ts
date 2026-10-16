import { z } from 'zod';
import { DateTimeSchema, NonBlankSchema } from './common.js';

export const ProjectSourceSchema = z.enum(['github', 'google_drive']);
export type ProjectSource = z.infer<typeof ProjectSourceSchema>;

/** Minimal project reference. Source of Truth: GitHub / Google Drive (spec §5.4). */
export const ProjectSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.literal('project'),
  title: z.string().min(1),
  source: ProjectSourceSchema,
  external_ref: z.string().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

/** A project returned by a tool: Phase 5 always carries the exact id. */
export const ProjectResultSchema = ProjectSchema.extend({ id: z.string().min(1) });
export type ProjectResult = z.infer<typeof ProjectResultSchema>;

/** Input of `project_list`. Both filters are optional; `{}` lists every repository the token can see. */
export const ProjectListFilterSchema = z.strictObject({
  /** Case-insensitive substring of the repository name, owner/repository or description. */
  query: NonBlankSchema.optional(),
  /** Case-insensitive exact match of the owner login (user or organization). */
  owner: NonBlankSchema.optional(),
});
export type ProjectListFilter = z.infer<typeof ProjectListFilterSchema>;

/** Input of `project_get`: an exact id (`github:<owner>/<repository>`) from `project_list`. */
export const ProjectGetInputSchema = z.strictObject({ id: z.string().min(1) });
export type ProjectGetInput = z.infer<typeof ProjectGetInputSchema>;

export const GitHubVisibilitySchema = z.enum(['public', 'private', 'internal']);
export type GitHubVisibility = z.infer<typeof GitHubVisibilitySchema>;

/** GitHub-specific details of `project_get`, kept apart from the provider-independent project. */
export const GitHubProjectDetailsSchema = z.strictObject({
  description: z.string().nullable(),
  owner: z.string().min(1),
  default_branch: z.string().min(1),
  visibility: GitHubVisibilitySchema,
  archived: z.boolean(),
  fork: z.boolean(),
  updated_at: DateTimeSchema,
});
export type GitHubProjectDetails = z.infer<typeof GitHubProjectDetailsSchema>;

/** `project_get` result: the common project and the provider details, side by side. */
export const ProjectGetResultSchema = z.object({
  project: ProjectResultSchema,
  details: GitHubProjectDetailsSchema,
});
export type ProjectGetResult = z.infer<typeof ProjectGetResultSchema>;
