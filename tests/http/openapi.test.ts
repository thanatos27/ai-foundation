import { Validator } from '@seriousme/openapi-schema-validator';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPERATION_NAMES } from '../../src/operations/index.js';
import { createTestApp, openApiDocument } from '../helpers/http.js';
import { repoConfig } from '../helpers/mcp.js';

/**
 * AC-07: the generated document covers the 21 operations with their inputs, outputs, security,
 * errors, descriptions and retry notes. The responses themselves are checked against it in every
 * HTTP test (expectConformsToDocument).
 */

type Doc = Awaited<ReturnType<typeof openApiDocument>> & Record<string, any>;
let doc: Doc;
const operations = () =>
  Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ path, method, operation: operation as Record<string, any> })),
  );
const operation = (name: string) => operations().find((o) => o.operation.operationId === name)!;
const resolve = (schema: Record<string, any>): Record<string, any> =>
  schema.$ref ? doc.components.schemas[schema.$ref.replace('#/components/schemas/', '')] as Record<string, any> : schema;

beforeAll(async () => {
  doc = (await openApiDocument(createTestApp({}))) as Doc;
});

describe('the document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(structuredClone(doc));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(doc.openapi).toBe('3.1.0');
  });

  it('requires the bearer API key everywhere', () => {
    expect(doc.components.securitySchemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.info.description).toContain('Authorization: Bearer <API key>');
  });

  it('describes the sources of truth and the HTTP conventions', () => {
    for (const text of ['Source of Truth: Todoist', 'Source of Truth: Obsidian', 'URL-encoded', '%2B', 'never retries']) {
      expect(doc.info.description).toContain(text);
    }
  });

  it('names the shared schemas as components', () => {
    expect(Object.keys(doc.components.schemas).sort()).toEqual(
      ['Area', 'CollectionItem', 'Error', 'GitHubProjectDetails', 'Knowledge', 'KnowledgeSearchResult', 'LifeLog', 'Project', 'Schedule', 'Task'].sort(),
    );
  });

  it('is generated without hand-written parts: every operation comes from a route', () => {
    expect(operations().map((o) => o.operation.operationId).sort()).toEqual([...OPERATION_NAMES].sort());
  });
});

describe('each operation', () => {
  it.each([...OPERATION_NAMES])('%s has a summary, a description with its retry note, a tag and responses', (name) => {
    const { operation: op } = operation(name);
    expect(op.summary).toEqual(expect.any(String));
    expect(op.description).toMatch(/Repeating: /);
    expect(op.tags).toHaveLength(1);
    const statuses = Object.keys(op.responses);
    expect(statuses.filter((s) => s.startsWith('2'))).toHaveLength(1);
    for (const status of ['400', '401', '500', '502', '503']) expect(statuses).toContain(status);
    for (const status of statuses.filter((s) => !s.startsWith('2'))) {
      expect(op.responses[status].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Error' });
      expect(op.responses[status].description).toEqual(expect.any(String));
    }
  });

  it.each([
    ['task_create', 'Not idempotent'],
    ['task_complete', 'completes the next occurrence'],
    ['task_update', 'Sending recurrence again'],
    ['collection_update', 'Sending append_note again'],
    ['knowledge_create', 'fails because the note exists'],
    ['lifelog_append', 'appends the content again'],
    ['schedule_update', 'Idempotent'],
    ['task_list', 'Safe to repeat'],
  ])('%s says how a repeat behaves', (name, text) => {
    expect(operation(name).operation.description).toContain(text);
  });

  it('declares 404 for operations that take an id, 409 for the creates that never overwrite, 413 for bodies', () => {
    for (const { method, path, operation: op } of operations()) {
      const statuses = Object.keys(op.responses);
      const takesId = path.includes('{id}') || path.endsWith('/entry') || path.endsWith('/entry/append');
      expect(statuses.includes('404'), `${op.operationId} 404`).toBe(takesId);
      expect(statuses.includes('409'), `${op.operationId} 409`).toBe(['knowledge_create', 'lifelog_create'].includes(op.operationId));
      expect(statuses.includes('413'), `${op.operationId} 413`).toBe(op.requestBody !== undefined);
      expect(op.requestBody === undefined, `${op.operationId} body`).toBe(method === 'get' || op.operationId === 'task_complete');
    }
  });

  it('documents the success status of each operation: 201 for creates, 200 otherwise', () => {
    for (const { operation: op } of operations()) {
      const success = Object.keys(op.responses).find((s) => s.startsWith('2'));
      expect(success, op.operationId).toBe(op.operationId.endsWith('_create') ? '201' : '200');
    }
  });
});

describe('inputs', () => {
  const parameter = (name: string, param: string) =>
    (operation(name).operation.parameters as Record<string, any>[]).find((p) => p.name === param)!;
  const body = (name: string) => resolve(operation(name).operation.requestBody.content['application/json'].schema);

  it('takes path ids as required path parameters, and slash ids as a required query parameter', () => {
    for (const name of ['task_update', 'task_complete', 'schedule_update', 'collection_update', 'area_get', 'lifelog_get', 'lifelog_append']) {
      expect(parameter(name, 'id')).toMatchObject({ in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
    }
    for (const name of ['knowledge_get', 'knowledge_append', 'project_get']) {
      expect(parameter(name, 'id')).toMatchObject({ in: 'query', required: true, schema: { type: 'string', minLength: 1 } });
      expect(parameter(name, 'id').description).toContain('%2B');
    }
  });

  it('marks the required query parameters', () => {
    expect(parameter('schedule_list', 'start').required).toBe(true);
    expect(parameter('schedule_list', 'end').required).toBe(true);
    expect(parameter('schedule_list', 'calendar').required).toBe(false);
    expect(parameter('task_list', 'area').required).toBe(false);
  });

  it('takes list filters as repeatable arrays', () => {
    for (const [name, param] of [
      ['task_list', 'status'],
      ['task_list', 'tags'],
      ['collection_search', 'tags'],
      ['knowledge_search', 'tags'],
    ]) {
      const p = parameter(name!, param!);
      expect(p.schema.type, `${name} ${param}`).toBe('array');
      expect(p.description).toContain('tags=a&tags=b');
    }
    expect(parameter('task_list', 'status').schema.items.enum).toEqual(['inbox', 'next', 'waiting', 'someday']);
  });

  it('offers "none" for knowledge without an area', () => {
    expect(parameter('knowledge_search', 'area').schema.enum).toEqual(['work', 'personal', 'none']);
  });

  it.each([
    ['task_create', ['title']],
    ['schedule_create', ['title', 'start']],
    ['collection_create', ['title', 'collection_type', 'status']],
    ['knowledge_create', ['title', 'content']],
    ['knowledge_append', ['content']],
    ['lifelog_create', ['date', 'title', 'content']],
    ['lifelog_append', ['content']],
    ['task_update', []],
    ['schedule_update', []],
    ['collection_update', []],
  ])('requires exactly the required fields of %s and refuses others', (name, required) => {
    const schema = body(name);
    expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
    expect(schema.additionalProperties).toBe(false);
    // The id travels in the path or the query, never in the body.
    expect(schema.properties.id).toBeUndefined();
  });

  it('marks the fields null can clear', () => {
    const nullable = (schema: Record<string, any>) =>
      JSON.stringify(schema).includes('"null"') || JSON.stringify(schema).includes('{"type":"null"}');
    expect(nullable(body('task_update').properties.due)).toBe(true);
    expect(nullable(body('task_update').properties.area)).toBe(true);
    expect(nullable(body('task_update').properties.title)).toBe(false);
    expect(nullable(body('schedule_update').properties.description)).toBe(true);
    expect(nullable(body('schedule_update').properties.start)).toBe(false);
    expect(nullable(body('collection_update').properties.status)).toBe(true);
  });

  it.each([
    ['task_create', 'Do not pass due together with recurrence'],
    ['task_update', 'recurrence must be the only field'],
    ['schedule_create', 'Do not mix the two forms'],
    ['schedule_update', 'giving only one keeps the other'],
    ['schedule_list', 'They may mix a date and a date-time'],
    ['collection_update', 'tags REPLACES all tags'],
  ])('%s explains the rules a schema cannot express', (name, text) => {
    expect(operation(name).operation.description).toContain(text);
  });

  it('names the configured calendars and time zone, from the config', () => {
    expect(operation('schedule_list').operation.description).toContain(repoConfig.defaults.timezone);
  });
});
