import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { LifeLogCreateInputSchema } from '../../domain/index.js';
import type { Operations } from '../../operations/index.js';
import { describeOperation, errors, jsonBody, success } from '../openapi.js';
import { idParam, LifeLogAppendBody, LifeLogDocumentResponse, LifeLogResponse } from '../schemas.js';

const TAG = 'Life Log';
const ID = idParam('lifelog:2026-10-03-東京散策.md');

export function registerLifeLogRoutes(app: OpenAPIHono, ops: Operations): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/lifelogs',
      ...describeOperation(ops.lifelog_create, TAG),
      request: { body: jsonBody(LifeLogCreateInputSchema) },
      responses: { ...success(201, LifeLogResponse, 'The created article'), ...errors([409, 413]) },
    }),
    async (c) => c.json(await ops.lifelog_create.run(c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/lifelogs/{id}',
      ...describeOperation(ops.lifelog_get, TAG),
      request: { params: ID },
      responses: { ...success(200, LifeLogDocumentResponse, 'The article and its full text'), ...errors([404]) },
    }),
    async (c) => c.json(await ops.lifelog_get.run({ id: c.req.valid('param').id }), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/lifelogs/{id}/append',
      ...describeOperation(ops.lifelog_append, TAG, 'The body is {"content": "..."}.'),
      request: { params: ID, body: jsonBody(LifeLogAppendBody) },
      responses: { ...success(200, LifeLogResponse, 'The article'), ...errors([404, 413]) },
    }),
    async (c) => c.json(await ops.lifelog_append.run({ id: c.req.valid('param').id, ...c.req.valid('json') }), 200),
  );
}
