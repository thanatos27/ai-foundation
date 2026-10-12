import { McpServer } from '@modelcontextprotocol/server';
import { INSTRUCTIONS } from './instructions.js';
import { registerTools, type ToolContext } from './tools/index.js';

export const SERVER_INFO = { name: 'ai-foundation', version: '0.1.0' };

/**
 * Builds a fully registered MCP server. No I/O: config is loaded by the caller,
 * and this may be invoked once per connection by `serveStdio`.
 */
export function createServer(context: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    // Declared explicitly so tools/list answers even while no tool is registered.
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  });
  registerTools(server, context);
  return server;
}
