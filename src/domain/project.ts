import { z } from 'zod';

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
