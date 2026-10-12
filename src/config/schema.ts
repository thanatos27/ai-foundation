import { z } from 'zod';
import { AreaSchema, KnowledgeSourceSchema, ProjectSourceSchema } from '../domain/index.js';

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Static Foundation configuration (spec §13).
 *
 * Every object is strict: unknown keys are rejected so that dynamic data
 * (project lists, IDs) and credentials cannot be added to config.yaml.
 */
export const ConfigSchema = z.strictObject({
  version: z.literal('0.1'),
  defaults: z.strictObject({
    area: AreaSchema,
    timezone: z.string().refine(isValidTimeZone, { message: 'Invalid IANA time zone' }),
  }),
  sources: z.strictObject({
    task: z.strictObject({ provider: z.enum(['todoist']) }),
    schedule: z.strictObject({ provider: z.enum(['google_calendar']) }),
    collection: z.strictObject({ provider: z.enum(['notion']) }),
    knowledge: z
      .strictObject({
        default: KnowledgeSourceSchema,
        providers: z.array(KnowledgeSourceSchema).min(1),
      })
      .refine((k) => k.providers.includes(k.default), {
        message: 'default must be one of providers',
        path: ['default'],
      }),
    project: z.strictObject({
      providers: z.array(ProjectSourceSchema).min(1),
    }),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
