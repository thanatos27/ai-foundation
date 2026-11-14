import type { McpServer } from '@modelcontextprotocol/server';
import { createScheduleOperations } from '../operations/schedule.js';
import type { ToolContext } from './index.js';
import { registerOperation } from './result.js';

/** Registers schedule_create / schedule_list / schedule_update (Source of Truth: Google Calendar). */
export function registerScheduleTools(server: McpServer, context: ToolContext): void {
  const ops = createScheduleOperations(context);
  registerOperation(server, ops.schedule_create, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  registerOperation(server, ops.schedule_list, { readOnlyHint: true, openWorldHint: true });
  registerOperation(server, ops.schedule_update, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
}
