import type { McpServer } from '@modelcontextprotocol/server';
import { createKnowledgeOperations } from '../operations/knowledge.js';
import type { ToolContext } from './index.js';
import { registerOperation } from './result.js';

/** Registers knowledge_create / knowledge_search / knowledge_get / knowledge_append (Source of Truth: Obsidian). */
export function registerKnowledgeTools(server: McpServer, context: ToolContext): void {
  const ops = createKnowledgeOperations(context);
  registerOperation(server, ops.knowledge_create, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  registerOperation(server, ops.knowledge_search, { readOnlyHint: true, openWorldHint: false });
  registerOperation(server, ops.knowledge_get, { readOnlyHint: true, openWorldHint: false });
  registerOperation(server, ops.knowledge_append, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
}
