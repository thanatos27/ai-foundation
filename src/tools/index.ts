import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config/schema.js';
import type { Connectors } from '../connectors/types.js';
import { registerAreaTools } from './area.js';
import { registerCollectionTools } from './collection.js';
import { registerKnowledgeTools } from './knowledge.js';
import { registerLifeLogTools } from './lifelog.js';
import { registerProjectTools } from './project.js';
import { registerScheduleTools } from './schedule.js';
import { registerTaskTools } from './task.js';

/** What tool handlers may use. Tools reach providers only through `connectors`. */
export interface ToolContext {
  config: Config;
  connectors: Connectors;
}

/**
 * Registers every public tool on `server`. Each entity has its own
 * `register<Entity>Tools(server, context)` that calls `server.registerTool()` directly.
 *
 * Tools are registered even when their connector is missing; calling one then returns a
 * configuration error, so the AI client still sees the tool and the reason it cannot run.
 */
export function registerTools(server: McpServer, context: ToolContext): void {
  registerTaskTools(server, context);
  registerScheduleTools(server, context);
  registerCollectionTools(server, context);
  registerKnowledgeTools(server, context);
  registerProjectTools(server, context);
  registerAreaTools(server, context);
  registerLifeLogTools(server, context);
}
