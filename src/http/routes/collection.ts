import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { CollectionCreateInputSchema } from '../../domain/index.js';
import type { Operations } from '../../operations/index.js';
import { describeOperation, errors, jsonBody, success } from '../openapi.js';
import {
  CollectionItemListResponse,
  CollectionItemResponse,
  CollectionSearchQuery,
  CollectionUpdateBody,
  idParam,
  NoQuery,
} from '../schemas.js';

const TAG = 'Collection';
const ID = idParam('notion:1f2e3d4c5b6a79881f2e3d4c5b6a7988');

export function registerCollectionRoutes(app: OpenAPIHono, ops: Operations): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/collection-items',
      ...describeOperation(ops.collection_search, TAG),
      request: { query: CollectionSearchQuery },
      responses: { ...success(200, CollectionItemListResponse, 'Matching items'), ...errors() },
    }),
    async (c) => c.json(await ops.collection_search.run(c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/collection-items',
      ...describeOperation(ops.collection_create, TAG),
      request: { query: NoQuery, body: jsonBody(CollectionCreateInputSchema) },
      responses: { ...success(201, CollectionItemResponse, 'The created item'), ...errors([413]) },
    }),
    async (c) => c.json(await ops.collection_create.run(c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/collection-items/{id}',
      ...describeOperation(ops.collection_update, TAG),
      request: { query: NoQuery, params: ID, body: jsonBody(CollectionUpdateBody) },
      responses: { ...success(200, CollectionItemResponse, 'The item after the update'), ...errors([404, 413]) },
    }),
    async (c) =>
      c.json(await ops.collection_update.run({ id: c.req.valid('param').id, ...c.req.valid('json') }), 200),
  );
}
