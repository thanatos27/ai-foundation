import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AreaConnector } from '../connectors/types.js';
import { AreaGetInputSchema, AreaGetResultSchema, AreaListFilterSchema, AreaResourceSchema } from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const ListOutputSchema = z.object({ items: z.array(AreaResourceSchema) });

/** Registers area_list / area_get (Source of Truth: Notion). Both are read-only. */
export function registerAreaTools(server: McpServer, { config, connectors }: ToolContext): void {
  const connector = (): AreaConnector => {
    if (!config.sources.area) throw new ConfigurationError('sources.area is not configured');
    if (!connectors.area) throw new ConfigurationError('the area source (Notion) is not configured');
    return connectors.area;
  };

  server.registerTool(
    'area_list',
    {
      title: 'List areas',
      description:
        `List areas: ongoing areas of responsibility (PARA "Areas", e.g. meals, assets, exercise, housework) that are ` +
        `maintained continuously. Work aimed at completion is a project instead (project_list). Each area is a Notion ` +
        `page that serves as a table of contents. query (optional) is a case-insensitive substring of the title; an ` +
        `empty filter lists every area. Results are sorted by title and carry no contents: pass the returned id to area_get.`,
      inputSchema: AreaListFilterSchema,
      outputSchema: ListOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (filter) => jsonResult({ items: await connector().list(filter) }),
  );

  server.registerTool(
    'area_get',
    {
      title: 'Get area',
      description:
        `Get one area by its exact id ("notion:<page-id>", from area_list; do not guess ids) with its table of ` +
        `contents as Markdown-like text. The contents link to related pages, knowledge, projects and so on; linked ` +
        `pages are not fetched. Follow a link with the matching tool: "obsidian:..." ids with knowledge_get, ` +
        `"github:<owner>/<repository>" ids with project_get; show other links (Notion pages, Google Drive, web) as URLs. ` +
        `Nested blocks are read up to 3 levels. Lines like "[unsupported Notion block: ...]" or ` +
        `"[nested blocks not retrieved: ...]" mark content that was not retrieved; open the area in Notion ` +
        `(external_ref) to see it.`,
      inputSchema: AreaGetInputSchema,
      outputSchema: AreaGetResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => jsonResult(await connector().get(id)),
  );
}
