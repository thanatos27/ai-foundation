import type { McpServer } from '@modelcontextprotocol/server';
import { createCollectionOperations } from '../operations/collection.js';
import type { ToolContext } from './index.js';
import { registerOperation } from './result.js';

/** Registers collection_create / collection_search / collection_update (Source of Truth: Notion). */
export function registerCollectionTools(server: McpServer, context: ToolContext): void {
  const ops = createCollectionOperations(context);
  registerOperation(server, ops.collection_create, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  registerOperation(server, ops.collection_search, { readOnlyHint: true, openWorldHint: true });
  registerOperation(server, ops.collection_update, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
}
