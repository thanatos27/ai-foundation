import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Operations } from '../../operations/index.js';
import { registerAreaRoutes } from './area.js';
import { registerCollectionRoutes } from './collection.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import { registerLifeLogRoutes } from './lifelog.js';
import { registerProjectRoutes } from './project.js';
import { registerScheduleRoutes } from './schedule.js';
import { registerTaskRoutes } from './task.js';

/** Registers the route of every operation (21) under /v1. */
export function registerRoutes(app: OpenAPIHono, ops: Operations): void {
  registerTaskRoutes(app, ops);
  registerScheduleRoutes(app, ops);
  registerCollectionRoutes(app, ops);
  registerKnowledgeRoutes(app, ops);
  registerProjectRoutes(app, ops);
  registerAreaRoutes(app, ops);
  registerLifeLogRoutes(app, ops);
}
