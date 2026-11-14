import type { McpServer } from '@modelcontextprotocol/server';
import { createProjectOperations } from '../operations/project.js';
import type { ToolContext } from './index.js';
import { registerOperation } from './result.js';

/** Registers project_list / project_get (Source of Truth: GitHub). Both are read-only. */
export function registerProjectTools(server: McpServer, context: ToolContext): void {
  const ops = createProjectOperations(context);
  registerOperation(server, ops.project_list, { readOnlyHint: true, openWorldHint: true });
  registerOperation(server, ops.project_get, { readOnlyHint: true, openWorldHint: true });
}
