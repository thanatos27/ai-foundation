import type { McpServer } from '@modelcontextprotocol/server';
import { createTaskOperations } from '../operations/task.js';
import type { ToolContext } from './index.js';
import { registerOperation } from './result.js';

/** Registers task_create / task_list / task_update / task_complete (Source of Truth: Todoist). */
export function registerTaskTools(server: McpServer, context: ToolContext): void {
  const ops = createTaskOperations(context);
  registerOperation(server, ops.task_create, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  registerOperation(server, ops.task_list, { readOnlyHint: true, openWorldHint: true });
  registerOperation(server, ops.task_update, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
  registerOperation(server, ops.task_complete, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
}
