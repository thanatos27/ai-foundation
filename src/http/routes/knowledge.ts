import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { KnowledgeCreateInputSchema } from '../../domain/index.js';
import type { Operations } from '../../operations/index.js';
import { describeOperation, errors, jsonBody, success } from '../openapi.js';
import {
  idQuery,
  KnowledgeAppendBody,
  KnowledgeDocumentResponse,
  KnowledgeResponse,
  KnowledgeSearchQuery,
  KnowledgeSearchResponse,
  NoQuery,
} from '../schemas.js';

const TAG = 'Knowledge';
const ID = idQuery('obsidian:AI_Foundation/Knowledge/CAP定理.md');

export function registerKnowledgeRoutes(app: OpenAPIHono, ops: Operations): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/knowledge',
      ...describeOperation(ops.knowledge_search, TAG, 'area=none matches knowledge without an area (area: null).'),
      request: { query: KnowledgeSearchQuery },
      responses: { ...success(200, KnowledgeSearchResponse, 'Matching knowledge, with snippets'), ...errors() },
    }),
    async (c) => c.json(await ops.knowledge_search.run(c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/knowledge',
      ...describeOperation(ops.knowledge_create, TAG),
      request: { query: NoQuery, body: jsonBody(KnowledgeCreateInputSchema) },
      responses: { ...success(201, KnowledgeResponse, 'The created knowledge'), ...errors([409, 413]) },
    }),
    async (c) => c.json(await ops.knowledge_create.run(c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/knowledge/entry',
      ...describeOperation(ops.knowledge_get, TAG),
      request: { query: ID },
      responses: { ...success(200, KnowledgeDocumentResponse, 'The metadata and the full body'), ...errors([404]) },
    }),
    async (c) => c.json(await ops.knowledge_get.run(c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/knowledge/entry/append',
      ...describeOperation(ops.knowledge_append, TAG, 'The id is a query parameter; the body is {"content": "..."}.'),
      request: { query: ID, body: jsonBody(KnowledgeAppendBody) },
      responses: { ...success(200, KnowledgeResponse, 'The knowledge metadata'), ...errors([404, 413]) },
    }),
    async (c) =>
      c.json(await ops.knowledge_append.run({ id: c.req.valid('query').id, ...c.req.valid('json') }), 200),
  );
}
