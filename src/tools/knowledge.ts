import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Config } from '../config/schema.js';
import type { KnowledgeConnector } from '../connectors/types.js';
import {
  KnowledgeAppendInputSchema,
  KnowledgeCreateInputSchema,
  KnowledgeDocumentSchema,
  KnowledgeGetInputSchema,
  KnowledgeSchema,
  KnowledgeSearchFilterSchema,
  KnowledgeSearchResultSchema,
} from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const KnowledgeOutputSchema = z.object({ knowledge: KnowledgeSchema });
const SearchOutputSchema = z.object({ items: z.array(KnowledgeSearchResultSchema) });

const TAGS =
  `Tags follow Obsidian's rules: written without "#", no spaces, only letters, numbers, "_", "-", "/" ` +
  `(nested tags) and non-ASCII characters such as Japanese, and not numbers only.`;

const READ_ONLY_METADATA =
  `title, description, area and tags cannot be changed after creation: no tool updates them, ` +
  `so do not offer to; the user edits them in Obsidian, and the next call reads the edited note.`;

/**
 * Resolves the knowledge source a call runs against. Phase 4 runs only when it resolves to Obsidian:
 * an omitted or `auto` source uses `sources.knowledge.default`.
 */
function resolveSource(source: 'auto' | 'obsidian' | undefined, config: Config): 'obsidian' {
  const knowledge = config.sources.knowledge;
  const resolved = source === undefined || source === 'auto' ? knowledge.default : source;
  if (resolved !== 'obsidian' || !knowledge.providers.includes('obsidian')) {
    throw new ConfigurationError(`the knowledge source "${resolved}" is not available in this version (only obsidian)`);
  }
  return resolved;
}

/** Registers knowledge_create / knowledge_search / knowledge_get / knowledge_append (Source of Truth: Obsidian). */
export function registerKnowledgeTools(server: McpServer, { config, connectors }: ToolContext): void {
  const defaultArea = config.defaults.area;
  /** Only knowledge_create applies the default source; the other tools always work on Obsidian. */
  const connector = (source: 'auto' | 'obsidian' | undefined): KnowledgeConnector => {
    resolveSource(source, config);
    if (!connectors.knowledge) throw new ConfigurationError('the knowledge source (Obsidian) is not configured');
    return connectors.knowledge;
  };

  server.registerTool(
    'knowledge_create',
    {
      title: 'Create knowledge',
      description:
        `Save reusable learning, thoughts or insights as a new Markdown note in the Obsidian vault ` +
        `(for executable actions use task_create, for events schedule_create, for books / games / movies collection_create). ` +
        `The file name comes from title, and an existing note is never overwritten: if one with the same name exists ` +
        `this fails, so to add to existing knowledge find it with knowledge_search and use knowledge_append. ` +
        `content is the Markdown body, saved as given. description is an optional one-line summary. ` +
        `area defaults to "${defaultArea}"; null means no area. ${TAGS} ${READ_ONLY_METADATA}`,
      inputSchema: KnowledgeCreateInputSchema,
      outputSchema: KnowledgeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ source, area, ...input }) =>
      jsonResult({
        knowledge: await connector(source).create({ ...input, area: area === undefined ? defaultArea : area }),
      }),
  );

  server.registerTool(
    'knowledge_search',
    {
      title: 'Search knowledge',
      description:
        `Search knowledge notes in the Obsidian vault (including subfolders). Every filter is optional and narrows the result: ` +
        `query is a case-insensitive substring of the title, description, tags or body; area matches exactly ` +
        `(null: notes without an area); tags must all be present (case-insensitive). An empty filter lists every note. ` +
        `Results are the most recently modified first and carry a short snippet, not the full body: ` +
        `pass the returned id to knowledge_get for the full text or to knowledge_append to add to it.`,
      inputSchema: KnowledgeSearchFilterSchema,
      outputSchema: SearchOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (filter) => jsonResult({ items: await connector('obsidian').search(filter) }),
  );

  server.registerTool(
    'knowledge_get',
    {
      title: 'Get knowledge',
      description:
        `Get the metadata and the full Markdown body of one knowledge note by its exact id ` +
        `("obsidian:<vault-relative-path>", from knowledge_search or knowledge_create). Do not guess ids: ` +
        `find the note with knowledge_search first. A note moved in Obsidian gets a new id; search again if the old one is not found.`,
      inputSchema: KnowledgeGetInputSchema,
      outputSchema: KnowledgeDocumentSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => jsonResult(await connector('obsidian').get(id)),
  );

  server.registerTool(
    'knowledge_append',
    {
      title: 'Append to knowledge',
      description:
        `Add content to the end of an existing knowledge note by its exact id (from knowledge_search). ` +
        `content is appended as given, as a new paragraph; the frontmatter (title, description, area, tags) and the ` +
        `existing body are not changed. No date or heading is added, so include one in content if wanted. ` +
        `Calling it again appends the content again. ${READ_ONLY_METADATA}`,
      inputSchema: KnowledgeAppendInputSchema,
      outputSchema: KnowledgeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => jsonResult({ knowledge: await connector('obsidian').append(input) }),
  );
}
