import type { McpServer } from '@modelcontextprotocol/server';
import { createLifeLogOperations } from '../operations/lifelog.js';
import type { ToolContext } from './index.js';
import { registerOperation } from './result.js';

/** Registers lifelog_create / lifelog_get / lifelog_append (Source of Truth: Obsidian). */
export function registerLifeLogTools(server: McpServer, context: ToolContext): void {
  const ops = createLifeLogOperations(context);
  registerOperation(server, ops.lifelog_create, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  registerOperation(server, ops.lifelog_get, { readOnlyHint: true, openWorldHint: false });
  registerOperation(server, ops.lifelog_append, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
}
