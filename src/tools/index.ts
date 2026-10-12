import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config/schema.js';
import type { Connectors } from '../connectors/types.js';

/** What tool handlers may use. Tools reach providers only through `connectors`. */
export interface ToolContext {
  config: Config;
  connectors: Connectors;
}

/**
 * Registers every public tool on `server`.
 *
 * Each entity adds its own `register<Entity>Tools(server, context)` that calls
 * `server.registerTool()` directly (Phase 2: task, schedule). Phase 1 exposes no tools.
 */
export function registerTools(_server: McpServer, _context: ToolContext): void {}
