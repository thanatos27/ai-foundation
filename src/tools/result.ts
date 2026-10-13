import type { CallToolResult } from '@modelcontextprotocol/server';

/** Returns `data` as structured content, with the same JSON as text for clients that ignore it. */
export function jsonResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
