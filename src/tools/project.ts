import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ProjectConnector } from '../connectors/types.js';
import {
  ProjectGetInputSchema,
  ProjectGetResultSchema,
  ProjectListFilterSchema,
  ProjectResultSchema,
} from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const ListOutputSchema = z.object({ items: z.array(ProjectResultSchema) });

/** Registers project_list / project_get (Source of Truth: GitHub). Both are read-only. */
export function registerProjectTools(server: McpServer, { config, connectors }: ToolContext): void {
  /** Phase 5 serves projects from GitHub only, and only while it is enabled in sources.project.providers. */
  const connector = (): ProjectConnector => {
    if (!config.sources.project.providers.includes('github')) {
      throw new ConfigurationError('the project provider "github" is not enabled in sources.project.providers');
    }
    if (!connectors.project) throw new ConfigurationError('the project source (GitHub) is not configured');
    return connectors.project;
  };

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description:
        `List projects: the GitHub repositories the configured token's user owns or takes part in, as GitHub's /user/repos ` +
        `returns them for the token (1 repository = 1 project). ` +
        `Every filter is optional and narrows the result: query is a case-insensitive substring of the repository name, ` +
        `owner/repository or description; owner matches the owner login (user or organization) exactly, ignoring case. ` +
        `An empty filter lists every repository. Repository names often use "-" instead of spaces, so prefer a single ` +
        `distinctive word as query, or list all and choose. Results are sorted by owner/repository and carry no README ` +
        `or contents: pass the returned id to project_get for details.`,
      inputSchema: ProjectListFilterSchema,
      outputSchema: ListOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (filter) => jsonResult({ items: await connector().list(filter) }),
  );

  server.registerTool(
    'project_get',
    {
      title: 'Get project',
      description:
        `Get one project by its exact id ("github:<owner>/<repository>", from project_list) with GitHub details ` +
        `(description, owner, default branch, visibility, archived, fork, updated_at). Do not guess ids: find the project ` +
        `with project_list first. If the repository was renamed or transferred, the current id is returned. Only ` +
        `repositories that project_list can return are available; any other repository is reported as not found. ` +
        `README, files, issues and pull requests are not included.`,
      inputSchema: ProjectGetInputSchema,
      outputSchema: ProjectGetResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => jsonResult(await connector().get(id)),
  );
}
