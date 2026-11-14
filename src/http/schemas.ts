// Imported from @hono/zod-openapi so that `.openapi()` is available on every schema below.
import { z } from '@hono/zod-openapi';
import {
  ActiveTaskStatusSchema,
  AreaGetResultSchema,
  AreaResourceSchema,
  AreaSchema,
  CollectionItemSchema,
  CollectionSearchFilterSchema,
  CollectionUpdateFields,
  GitHubProjectDetailsSchema,
  KnowledgeAppendInputSchema,
  KnowledgeSchema,
  KnowledgeSearchFilterSchema,
  KnowledgeSearchResultSchema,
  LifeLogAppendInputSchema,
  LifeLogSchema,
  ProjectResultSchema,
  ScheduleSchema,
  ScheduleUpdateFields,
  TagsSchema,
  TaskListFilterSchema,
  TaskSchema,
  TaskUpdateFields,
  withCollectionUpdateRules,
  withScheduleUpdateRules,
  withTaskUpdateRules,
} from '../domain/index.js';
import { HTTP_ERROR_CODES } from './errors.js';

/**
 * Schemas of the HTTP API. Inputs reuse the domain schemas and their rules; outputs are the
 * operations' payloads with OpenAPI component names. Nothing here changes the domain schemas.
 */

// ---- Components -----------------------------------------------------------------------------

const Task = TaskSchema.meta({ id: 'Task' });
const Schedule = ScheduleSchema.meta({ id: 'Schedule' });
const CollectionItem = CollectionItemSchema.meta({ id: 'CollectionItem' });
const Knowledge = KnowledgeSchema.meta({ id: 'Knowledge' });
const KnowledgeSearchResult = KnowledgeSearchResultSchema.meta({ id: 'KnowledgeSearchResult' });
const Project = ProjectResultSchema.meta({ id: 'Project' });
const GitHubProjectDetails = GitHubProjectDetailsSchema.meta({ id: 'GitHubProjectDetails' });
const Area = AreaResourceSchema.meta({ id: 'Area' });
const LifeLog = LifeLogSchema.meta({ id: 'LifeLog' });

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(HTTP_ERROR_CODES).openapi({ description: 'Machine-readable error code' }),
      message: z.string().openapi({ description: 'What went wrong, for people and AI clients' }),
    }),
  })
  .openapi('Error');

// ---- Responses (the same payloads as the MCP tools) -----------------------------------------

export const TaskResponse = z.object({ task: Task });
export const TaskListResponse = z.object({ tasks: z.array(Task) });
export const ScheduleResponse = z.object({ schedule: Schedule });
export const ScheduleListResponse = z.object({ schedules: z.array(Schedule) });
export const CollectionItemResponse = z.object({ item: CollectionItem });
export const CollectionItemListResponse = z.object({ items: z.array(CollectionItem) });
export const KnowledgeResponse = z.object({ knowledge: Knowledge });
export const KnowledgeSearchResponse = z.object({ items: z.array(KnowledgeSearchResult) });
export const KnowledgeDocumentResponse = z.object({ knowledge: Knowledge, content: z.string() });
export const ProjectListResponse = z.object({ items: z.array(Project) });
export const ProjectGetResponse = z.object({ project: Project, details: GitHubProjectDetails });
export const AreaListResponse = z.object({ items: z.array(Area) });
export const AreaGetResponse = z.object({ area: Area, content: AreaGetResultSchema.shape.content });
export const LifeLogResponse = z.object({ lifelog: LifeLog });
export const LifeLogDocumentResponse = z.object({ lifelog: LifeLog, content: z.string() });

// ---- Path and query -------------------------------------------------------------------------

/** A query value that may be repeated (`?tags=a&tags=b`); a single value is a list of one. */
export function queryArray<T extends z.ZodType>(item: T) {
  return z.preprocess((value) => (typeof value === 'string' ? [value] : value), z.array(item));
}

const REPEAT_FOR_MORE = 'Repeat the parameter for several values, e.g. tags=a&tags=b.';

/** The `{id}` path parameter, URL-encoded by the client. */
export function idParam(example: string) {
  return z.object({
    id: z
      .string()
      .min(1)
      .openapi({
        param: { name: 'id', in: 'path' },
        description: 'The exact id from a previous result, URL-encoded (e.g. with encodeURIComponent).',
        example,
      }),
  });
}

/** The required `id` query parameter, for ids that contain "/". */
export function idQuery(example: string) {
  return z.strictObject({
    id: z
      .string()
      .min(1)
      .openapi({
        description:
          'The exact id from a previous result, URL-encoded (e.g. with encodeURIComponent; "+" must be sent as %2B, ' +
          'since a bare "+" in a query reads as a space).',
        example,
      }),
  });
}

export const TaskListQuery = z.strictObject({
  ...TaskListFilterSchema.shape,
  status: queryArray(ActiveTaskStatusSchema).optional().openapi({ description: `Any of these statuses. ${REPEAT_FOR_MORE}` }),
  tags: queryArray(TagsSchema.element).optional().openapi({ description: `All of these tags. ${REPEAT_FOR_MORE}` }),
});

export const CollectionSearchQuery = z.strictObject({
  ...CollectionSearchFilterSchema.shape,
  tags: queryArray(TagsSchema.element).optional().openapi({ description: `All of these tags. ${REPEAT_FOR_MORE}` }),
});

/** `area=none` is `area: null` (knowledge without an area), which a query cannot carry as such. */
export const KNOWLEDGE_AREA_NONE = 'none';
export const KnowledgeSearchQuery = z.strictObject({
  ...KnowledgeSearchFilterSchema.shape,
  area: z
    .preprocess((value) => (value === KNOWLEDGE_AREA_NONE ? null : value), AreaSchema.nullable())
    .optional()
    .openapi({
      type: 'string',
      enum: [...AreaSchema.options, KNOWLEDGE_AREA_NONE],
      description: `Exact area; "${KNOWLEDGE_AREA_NONE}" matches knowledge without an area.`,
    }),
  tags: queryArray(TagsSchema.element).optional().openapi({ description: `All of these tags. ${REPEAT_FOR_MORE}` }),
});

// ---- Bodies ---------------------------------------------------------------------------------

/** `task_update` without `id` (it is in the path); the same cross-field rules. */
export const TaskUpdateBody = withTaskUpdateRules(z.strictObject(TaskUpdateFields));
export const ScheduleUpdateBody = withScheduleUpdateRules(z.strictObject(ScheduleUpdateFields));
export const CollectionUpdateBody = withCollectionUpdateRules(z.strictObject(CollectionUpdateFields));
export const KnowledgeAppendBody = KnowledgeAppendInputSchema.omit({ id: true });
export const LifeLogAppendBody = LifeLogAppendInputSchema.omit({ id: true });
