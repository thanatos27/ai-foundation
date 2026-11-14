import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { AreaListFilterSchema } from '../../domain/index.js';
import type { Operations } from '../../operations/index.js';
import { describeOperation, errors, success } from '../openapi.js';
import { AreaGetResponse, AreaListResponse, idParam, NoQuery } from '../schemas.js';

const TAG = 'Area';

export function registerAreaRoutes(app: OpenAPIHono, ops: Operations): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/areas',
      ...describeOperation(ops.area_list, TAG),
      request: { query: AreaListFilterSchema },
      responses: { ...success(200, AreaListResponse, 'Matching areas'), ...errors() },
    }),
    async (c) => c.json(await ops.area_list.run(c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/areas/{id}',
      ...describeOperation(ops.area_get, TAG),
      request: { query: NoQuery, params: idParam('notion:1f2e3d4c5b6a79881f2e3d4c5b6a7988') },
      responses: { ...success(200, AreaGetResponse, 'The area and its table of contents'), ...errors([404]) },
    }),
    async (c) => c.json(await ops.area_get.run({ id: c.req.valid('param').id }), 200),
  );
}
