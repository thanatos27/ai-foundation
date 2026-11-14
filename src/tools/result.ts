import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/** Returns `data` as structured content, with the same JSON as text for clients that ignore it. */
export function jsonResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** The parts of an `Operation` a tool needs, without its input and output types. */
interface ToolOperation {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  run(input: never): Promise<object>;
}

/**
 * Registers `operation` as the MCP tool of the same name. The SDK validates the input against
 * `operation.input` before the handler runs, and turns a thrown error into an `isError` result.
 */
export function registerOperation(server: McpServer, operation: ToolOperation, annotations: ToolAnnotations): void {
  // The SDK has parsed the input with operation.input, which is what run() takes.
  const run = operation.run as (input: unknown) => Promise<Record<string, unknown>>;
  server.registerTool(
    operation.name,
    {
      title: operation.title,
      description: operation.description,
      inputSchema: operation.input,
      outputSchema: operation.output,
      annotations,
    },
    async (input) => jsonResult(await run(input)),
  );
}
