import type { McpServer } from '@modelcontextprotocol/server';
import { createAreaOperations } from '../operations/area.js';
import type { ToolContext } from './index.js';
import { registerOperation } from './result.js';

/** Registers area_list / area_get (Source of Truth: Notion). Both are read-only. */
export function registerAreaTools(server: McpServer, context: ToolContext): void {
  const ops = createAreaOperations(context);
  registerOperation(server, ops.area_list, { readOnlyHint: true, openWorldHint: true });
  registerOperation(server, ops.area_get, { readOnlyHint: true, openWorldHint: true });
}
