import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  AreaResourceSourceSchema,
  AreaSchema,
  KnowledgeSourceSchema,
  LifeLogSourceSchema,
  ProjectSourceSchema,
} from '../domain/index.js';

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory inside the vault, as a relative path with `/` separators (e.g. `AI Foundation/Knowledge`).
 * The vault root itself (`.` or empty) is not allowed: the knowledge tools never read or write the whole vault.
 */
const VaultRelativeDirSchema = z
  .string()
  .min(1)
  .refine((dir) => !/[\\\u0000-\u001f\u007f]/.test(dir), { message: 'must use "/" separators and no control characters' })
  .refine((dir) => !dir.startsWith('/') && !/^[A-Za-z]:/.test(dir), { message: 'must be relative to the vault' })
  .refine((dir) => dir.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'), {
    message: 'must not contain empty, "." or ".." segments',
  });

/** A Notion page ID: the hyphenated UUID or the 32-hex form used in Notion URLs. */
const NotionPageIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i, {
    message: 'must be a Notion page ID (UUID or 32 hex characters)',
  });

/**
 * Whether two vault directories are the same or one contains the other. Compared case-insensitively,
 * as the file systems of Windows and macOS do.
 */
function dirsOverlap(a: string, b: string): boolean {
  const [shorter, longer] = [a, b].map((dir) => dir.toLowerCase().split('/')).sort((x, y) => x.length - y.length);
  return shorter!.every((segment, index) => longer![index] === segment);
}

/**
 * Static Foundation configuration (spec §13).
 *
 * Every object is strict: unknown keys are rejected so that dynamic data
 * (project lists, IDs) and credentials cannot be added to config.yaml.
 */
const ConfigObjectSchema = z.strictObject({
  version: z.literal('0.1'),
  defaults: z.strictObject({
    area: AreaSchema,
    timezone: z.string().refine(isValidTimeZone, { message: 'Invalid IANA time zone' }),
  }),
  sources: z.strictObject({
    task: z.strictObject({ provider: z.enum(['todoist']) }),
    schedule: z.strictObject({
      provider: z.enum(['google_calendar']),
      /**
       * The only calendar AI Foundation writes to. Not a secret, but personal: keep it in a
       * local config file rather than the committed config.yaml. Optional so the server still
       * starts (and schedule_list works) without it.
       */
      writable_calendar_id: z.string().min(1).optional(),
    }),
    collection: z.strictObject({
      provider: z.enum(['notion']),
      /**
       * The Notion data source AI Foundation reads from and writes to. Not a secret, but personal:
       * keep it in a local config file rather than the committed config.yaml. Optional so the server
       * still starts; the collection tools return a configuration error without it.
       */
      data_source_id: z.string().min(1).optional(),
    }),
    knowledge: z
      .strictObject({
        default: KnowledgeSourceSchema,
        providers: z.array(KnowledgeSourceSchema).min(1),
        /**
         * How the Obsidian vault is reached. Optional so the server still starts; the knowledge tools
         * return a configuration error while vault_path or knowledge_dir is missing.
         */
        obsidian: z
          .strictObject({
            storage: z.literal('filesystem'),
            /** Absolute path of the vault on this machine. Personal: keep it in a local config file. */
            vault_path: z.string().min(1).refine(isAbsolute, { message: 'must be an absolute path' }).optional(),
            /** The only directory the knowledge tools read and write, relative to the vault. */
            knowledge_dir: VaultRelativeDirSchema.optional(),
          })
          .optional(),
      })
      .refine((k) => k.providers.includes(k.default), {
        message: 'default must be one of providers',
        path: ['default'],
      }),
    project: z.strictObject({
      providers: z.array(ProjectSourceSchema).min(1),
    }),
    /**
     * PARA areas (not the work / personal `defaults.area`). Optional so that existing local configs
     * keep working; the area tools return a configuration error without it.
     */
    area: z
      .strictObject({
        provider: AreaResourceSourceSchema,
        notion: z
          .strictObject({
            /**
             * The page whose direct child pages are the areas. Not a secret, but personal: keep it in
             * a local config file. Optional so the server still starts; the area tools need it.
             */
            parent_page_id: NotionPageIdSchema.optional(),
          })
          .optional(),
      })
      .optional(),
    /**
     * Life log articles in a directory of the knowledge vault (sources.knowledge.obsidian.vault_path).
     * Optional so that existing local configs keep working; the lifelog tools return a configuration
     * error without it.
     */
    lifelog: z
      .strictObject({
        provider: LifeLogSourceSchema,
        obsidian: z
          .strictObject({
            /** The only directory the lifelog tools read and write, relative to the vault. */
            directory: VaultRelativeDirSchema.optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});

/** The configuration, with the checks that span several sources. */
export const ConfigSchema = ConfigObjectSchema.refine(
  (config) => {
    // knowledge_search reads knowledge_dir recursively: life logs inside it would become knowledge.
    const lifelogDir = config.sources.lifelog?.obsidian?.directory;
    const knowledgeDir = config.sources.knowledge.obsidian?.knowledge_dir;
    return !lifelogDir || !knowledgeDir || !dirsOverlap(lifelogDir, knowledgeDir);
  },
  {
    message: 'must not be the same as, inside or contain sources.knowledge.obsidian.knowledge_dir',
    path: ['sources', 'lifelog', 'obsidian', 'directory'],
  },
);

export type Config = z.infer<typeof ConfigSchema>;
