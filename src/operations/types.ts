import type { z } from 'zod';
import type { Config } from '../config/schema.js';
import type { Connectors } from '../connectors/types.js';

/** What operations may use. They reach providers only through `connectors`. */
export interface OperationContext {
  config: Config;
  connectors: Connectors;
}

/** Every public operation: the MCP tool name, which is also the HTTP API's operationId. */
export const OPERATION_NAMES = [
  'task_create',
  'task_list',
  'task_update',
  'task_complete',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'collection_create',
  'collection_search',
  'collection_update',
  'knowledge_create',
  'knowledge_search',
  'knowledge_get',
  'knowledge_append',
  'project_list',
  'project_get',
  'area_list',
  'area_get',
  'lifelog_create',
  'lifelog_get',
  'lifelog_append',
] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

/**
 * What happens when the same request is sent again (e.g. after a timeout whose result is unknown).
 * `conditional`: depends on the input, which `note` names.
 */
export type Repeat =
  | { kind: 'safe' | 'idempotent' | 'not_idempotent' | 'conflict_on_repeat'; note?: string }
  | { kind: 'conditional'; note: string };

/**
 * One public operation, shared by the MCP tool and the HTTP route of the same name: what it does
 * (title, description), what it takes and returns, and how it runs. Transport details (MCP
 * annotations, HTTP paths) stay with the transport.
 */
export interface Operation<In extends z.ZodType = z.ZodType, Out extends z.ZodType = z.ZodType> {
  name: OperationName;
  title: string;
  description: string;
  /** The full domain input; the MCP tool's inputSchema. */
  input: In;
  /** The payload; the MCP tool's outputSchema and the HTTP success body. */
  output: Out;
  repeat: Repeat;
  /** Runs on input that `input` already validated. */
  run(input: z.output<In>): Promise<z.output<Out>>;
}

/** Keeps the input and output types of each operation (an annotation would widen them). */
export function defineOperation<In extends z.ZodType, Out extends z.ZodType>(
  operation: Operation<In, Out>,
): Operation<In, Out> {
  return operation;
}
