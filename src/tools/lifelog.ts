import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { LifeLogConnector } from '../connectors/types.js';
import {
  LifeLogAppendInputSchema,
  LifeLogCreateInputSchema,
  LifeLogDocumentSchema,
  LifeLogGetInputSchema,
  LifeLogSchema,
} from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const LifeLogOutputSchema = z.object({ lifelog: LifeLogSchema });

const IDS =
  `An id is "lifelog:" followed by the file name in the life log folder (e.g. "lifelog:2026-10-03-東京散策.md"). ` +
  `There is no tool to list or search articles: use the id lifelog_create returned, or the exact file name the user ` +
  `read in Obsidian (articles written there by hand work too). Do not guess file names; if neither the id nor the ` +
  `file name is known, the article cannot be reached here, so ask the user to check the file name in Obsidian.`;

/** Registers lifelog_create / lifelog_get / lifelog_append (Source of Truth: Obsidian). */
export function registerLifeLogTools(server: McpServer, { config, connectors }: ToolContext): void {
  const connector = (): LifeLogConnector => {
    if (!config.sources.lifelog) throw new ConfigurationError('sources.lifelog is not configured');
    if (!connectors.lifelog) throw new ConfigurationError('the life log source (Obsidian) is not configured');
    return connectors.lifelog;
  };

  server.registerTool(
    'lifelog_create',
    {
      title: 'Create life log',
      description:
        `Record something that happened on a day (a trip, an outing, an event) as a new free-form Markdown article in ` +
        `the Obsidian vault's life log folder. Reusable learning or insights go to knowledge_create, plans to ` +
        `schedule_create. date is the day the article is about (YYYY-MM-DD). The file is named ` +
        `"YYYY-MM-DD-<title>.md": several articles can share a date with different titles, but an existing article is ` +
        `never overwritten: if one with the same date and title exists this fails, so add to it with lifelog_append. ` +
        `content is saved as given (only line endings are normalized); no frontmatter, heading or date is added, so ` +
        `write the article in content. For images or videos, put links to where they are stored in content. ` +
        `Keep the returned id to get or append to the article later.`,
      inputSchema: LifeLogCreateInputSchema,
      outputSchema: LifeLogOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => jsonResult({ lifelog: await connector().create(input) }),
  );

  server.registerTool(
    'lifelog_get',
    {
      title: 'Get life log',
      description: `Get one life log article and its full Markdown text by its exact id. ${IDS}`,
      inputSchema: LifeLogGetInputSchema,
      outputSchema: LifeLogDocumentSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => jsonResult(await connector().get(id)),
  );

  server.registerTool(
    'lifelog_append',
    {
      title: 'Append to life log',
      description:
        `Add content to the end of an existing life log article, as a new paragraph. The existing text is not ` +
        `changed. No date or heading is added, so include one in content if wanted. Calling it again appends the ` +
        `content again. ${IDS}`,
      inputSchema: LifeLogAppendInputSchema,
      outputSchema: LifeLogOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => jsonResult({ lifelog: await connector().append(input) }),
  );
}
