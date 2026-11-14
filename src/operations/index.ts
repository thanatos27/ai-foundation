import { createAreaOperations } from './area.js';
import { createCollectionOperations } from './collection.js';
import { createKnowledgeOperations } from './knowledge.js';
import { createLifeLogOperations } from './lifelog.js';
import { createProjectOperations } from './project.js';
import { createScheduleOperations } from './schedule.js';
import { createTaskOperations } from './task.js';
import type { OperationContext } from './types.js';

export * from './types.js';

/**
 * Every public operation, by name. No I/O: connectors are reached only when an operation runs, and
 * an operation whose connector is missing fails with a configuration error then.
 */
export function createOperations(context: OperationContext) {
  return {
    ...createTaskOperations(context),
    ...createScheduleOperations(context),
    ...createCollectionOperations(context),
    ...createKnowledgeOperations(context),
    ...createProjectOperations(context),
    ...createAreaOperations(context),
    ...createLifeLogOperations(context),
  };
}

export type Operations = ReturnType<typeof createOperations>;
