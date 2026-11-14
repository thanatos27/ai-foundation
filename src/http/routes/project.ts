import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ProjectListFilterSchema } from '../../domain/index.js';
import type { Operations } from '../../operations/index.js';
import { describeOperation, errors, success } from '../openapi.js';
import { idQuery, ProjectGetResponse, ProjectListResponse } from '../schemas.js';

const TAG = 'Project';

export function registerProjectRoutes(app: OpenAPIHono, ops: Operations): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/projects',
      ...describeOperation(ops.project_list, TAG),
      request: { query: ProjectListFilterSchema },
      responses: { ...success(200, ProjectListResponse, 'Matching projects'), ...errors() },
    }),
    async (c) => c.json(await ops.project_list.run(c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/projects/entry',
      ...describeOperation(ops.project_get, TAG),
      request: { query: idQuery('github:octocat/hello-world') },
      responses: { ...success(200, ProjectGetResponse, 'The project and its GitHub details'), ...errors([404]) },
    }),
    async (c) => c.json(await ops.project_get.run(c.req.valid('query')), 200),
  );
}
