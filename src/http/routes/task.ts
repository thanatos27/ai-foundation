import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { TaskCreateInputSchema } from '../../domain/index.js';
import type { Operations } from '../../operations/index.js';
import { describeOperation, errors, jsonBody, success } from '../openapi.js';
import { idParam, TaskListQuery, TaskListResponse, TaskResponse, TaskUpdateBody } from '../schemas.js';

const TAG = 'Task';
const ID = idParam('todoist:6Xg8hP3fQ2');

export function registerTaskRoutes(app: OpenAPIHono, ops: Operations): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/tasks',
      ...describeOperation(ops.task_list, TAG),
      request: { query: TaskListQuery },
      responses: { ...success(200, TaskListResponse, 'Open tasks in the Inbox'), ...errors() },
    }),
    async (c) => c.json(await ops.task_list.run(c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/tasks',
      ...describeOperation(ops.task_create, TAG),
      request: { body: jsonBody(TaskCreateInputSchema) },
      responses: { ...success(201, TaskResponse, 'The created task'), ...errors([413]) },
    }),
    async (c) => c.json(await ops.task_create.run(c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/tasks/{id}',
      ...describeOperation(ops.task_update, TAG),
      request: { params: ID, body: jsonBody(TaskUpdateBody) },
      responses: { ...success(200, TaskResponse, 'The task after the update'), ...errors([404, 413]) },
    }),
    async (c) => c.json(await ops.task_update.run({ id: c.req.valid('param').id, ...c.req.valid('json') }), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/tasks/{id}/complete',
      ...describeOperation(ops.task_complete, TAG, 'No request body.'),
      request: { params: ID },
      responses: {
        ...success(200, TaskResponse, 'The task afterwards: done, or the next occurrence of a recurring task'),
        ...errors([404]),
      },
    }),
    async (c) => c.json(await ops.task_complete.run({ id: c.req.valid('param').id }), 200),
  );
}
