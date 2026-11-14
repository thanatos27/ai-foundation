import { beforeEach, describe, expect, it } from 'vitest';
import { OPERATION_NAMES } from '../../src/operations/index.js';
import {
  FakeAreaConnector,
  FakeCollectionConnector,
  FakeKnowledgeConnector,
  FakeLifeLogConnector,
  FakeProjectConnector,
  FakeScheduleConnector,
  FakeTaskConnector,
} from '../helpers/fake-connectors.js';
import { call, type CallOptions, createTestApp, expectConformsToDocument, openApiDocument, type TestApp, withId } from '../helpers/http.js';

/** AC-01: every operation answers at its method and path, with its status and payload. */

let task: FakeTaskConnector;
let schedule: FakeScheduleConnector;
let collection: FakeCollectionConnector;
let knowledge: FakeKnowledgeConnector;
let project: FakeProjectConnector;
let area: FakeAreaConnector;
let lifelog: FakeLifeLogConnector;
let app: TestApp;

beforeEach(() => {
  task = new FakeTaskConnector();
  schedule = new FakeScheduleConnector();
  collection = new FakeCollectionConnector();
  knowledge = new FakeKnowledgeConnector();
  project = new FakeProjectConnector();
  area = new FakeAreaConnector();
  lifelog = new FakeLifeLogConnector();
  app = createTestApp({ task, schedule, collection, knowledge, project, area, lifelog });
});

const KNOWLEDGE_ID = 'obsidian:AI Foundation/Knowledge/CAP定理.md';
const LIFELOG_ID = 'lifelog:2026-10-03-東京散策.md';
const SCHEDULE_ID = 'google_calendar:af@group.calendar.google.com:evt1';
const NOTION_ID = 'notion:1f2e3d4c5b6a79881f2e3d4c5b6a7988';

interface Case {
  operation: (typeof OPERATION_NAMES)[number];
  method: string;
  /** The path as the document names it. */
  template: string;
  path: string;
  options?: CallOptions;
  status: 200 | 201;
  /** The connector call the request must make. */
  expectedCall: () => { calls: { method: string; arg: unknown }[] } | undefined;
  method_: string;
  arg: unknown;
  /** Top-level keys of the payload. */
  keys: string[];
}

const cases: Case[] = [
  { operation: 'task_list', method: 'GET', template: '/v1/tasks', path: '/v1/tasks', options: { query: { status: ['inbox', 'next'], area: 'work', due_before: '2026-11-30', tags: 'x' } }, status: 200, expectedCall: () => task, method_: 'list', arg: { status: ['inbox', 'next'], area: 'work', due_before: '2026-11-30', tags: ['x'] }, keys: ['tasks'] },
  { operation: 'task_create', method: 'POST', template: '/v1/tasks', path: '/v1/tasks', options: { body: { title: '経費精算', due: '2026-11-20' } }, status: 201, expectedCall: () => task, method_: 'create', arg: { title: '経費精算', due: '2026-11-20' }, keys: ['task'] },
  { operation: 'task_update', method: 'PATCH', template: '/v1/tasks/{id}', path: withId('/v1/tasks', 'todoist:t1'), options: { body: { title: 'new' } }, status: 200, expectedCall: () => task, method_: 'update', arg: { id: 'todoist:t1', title: 'new' }, keys: ['task'] },
  { operation: 'task_complete', method: 'POST', template: '/v1/tasks/{id}/complete', path: withId('/v1/tasks', 'todoist:t1', '/complete'), status: 200, expectedCall: () => task, method_: 'complete', arg: 'todoist:t1', keys: ['task'] },
  { operation: 'schedule_list', method: 'GET', template: '/v1/schedules', path: '/v1/schedules', options: { query: { start: '2026-11-01', end: '2026-11-30', calendar: 'personal' } }, status: 200, expectedCall: () => schedule, method_: 'list', arg: { start: '2026-11-01', end: '2026-11-30', calendar: 'personal' }, keys: ['schedules'] },
  { operation: 'schedule_create', method: 'POST', template: '/v1/schedules', path: '/v1/schedules', options: { body: { title: '展示会', start: '2026-11-21', end: '2026-11-23' } }, status: 201, expectedCall: () => schedule, method_: 'create', arg: { title: '展示会', start: '2026-11-21', end: '2026-11-23' }, keys: ['schedule'] },
  { operation: 'schedule_update', method: 'PATCH', template: '/v1/schedules/{id}', path: withId('/v1/schedules', SCHEDULE_ID), options: { body: { location: null } }, status: 200, expectedCall: () => schedule, method_: 'update', arg: { id: SCHEDULE_ID, location: null }, keys: ['schedule'] },
  { operation: 'collection_search', method: 'GET', template: '/v1/collection-items', path: '/v1/collection-items', options: { query: { query: 'Zelda', collection_type: 'game', status: 'playing', tags: ['rpg', 'switch'] } }, status: 200, expectedCall: () => collection, method_: 'search', arg: { query: 'Zelda', collection_type: 'game', status: 'playing', tags: ['rpg', 'switch'] }, keys: ['items'] },
  { operation: 'collection_create', method: 'POST', template: '/v1/collection-items', path: '/v1/collection-items', options: { body: { title: 'Zelda', collection_type: 'game', status: 'wishlist' } }, status: 201, expectedCall: () => collection, method_: 'create', arg: { title: 'Zelda', collection_type: 'game', status: 'wishlist' }, keys: ['item'] },
  { operation: 'collection_update', method: 'PATCH', template: '/v1/collection-items/{id}', path: withId('/v1/collection-items', NOTION_ID), options: { body: { status: 'playing' } }, status: 200, expectedCall: () => collection, method_: 'update', arg: { id: NOTION_ID, status: 'playing' }, keys: ['item'] },
  { operation: 'knowledge_search', method: 'GET', template: '/v1/knowledge', path: '/v1/knowledge', options: { query: { query: 'CAP', area: 'work', tags: 'db' } }, status: 200, expectedCall: () => knowledge, method_: 'search', arg: { query: 'CAP', area: 'work', tags: ['db'] }, keys: ['items'] },
  { operation: 'knowledge_create', method: 'POST', template: '/v1/knowledge', path: '/v1/knowledge', options: { body: { title: 'CAP定理', content: '本文', area: 'work' } }, status: 201, expectedCall: () => knowledge, method_: 'create', arg: { title: 'CAP定理', content: '本文', area: 'work' }, keys: ['knowledge'] },
  { operation: 'knowledge_get', method: 'GET', template: '/v1/knowledge/entry', path: '/v1/knowledge/entry', options: { query: { id: KNOWLEDGE_ID } }, status: 200, expectedCall: () => knowledge, method_: 'get', arg: KNOWLEDGE_ID, keys: ['knowledge', 'content'] },
  { operation: 'knowledge_append', method: 'POST', template: '/v1/knowledge/entry/append', path: '/v1/knowledge/entry/append', options: { query: { id: KNOWLEDGE_ID }, body: { content: '追記' } }, status: 200, expectedCall: () => knowledge, method_: 'append', arg: { id: KNOWLEDGE_ID, content: '追記' }, keys: ['knowledge'] },
  { operation: 'project_list', method: 'GET', template: '/v1/projects', path: '/v1/projects', options: { query: { query: 'robot', owner: 'octocat' } }, status: 200, expectedCall: () => project, method_: 'list', arg: { query: 'robot', owner: 'octocat' }, keys: ['items'] },
  { operation: 'project_get', method: 'GET', template: '/v1/projects/entry', path: '/v1/projects/entry', options: { query: { id: 'github:octocat/hello-world' } }, status: 200, expectedCall: () => project, method_: 'get', arg: 'github:octocat/hello-world', keys: ['project', 'details'] },
  { operation: 'area_list', method: 'GET', template: '/v1/areas', path: '/v1/areas', options: { query: { query: '食事' } }, status: 200, expectedCall: () => area, method_: 'list', arg: { query: '食事' }, keys: ['items'] },
  { operation: 'area_get', method: 'GET', template: '/v1/areas/{id}', path: withId('/v1/areas', NOTION_ID), status: 200, expectedCall: () => area, method_: 'get', arg: NOTION_ID, keys: ['area', 'content'] },
  { operation: 'lifelog_create', method: 'POST', template: '/v1/lifelogs', path: '/v1/lifelogs', options: { body: { date: '2026-10-03', title: '東京散策', content: '本文' } }, status: 201, expectedCall: () => lifelog, method_: 'create', arg: { date: '2026-10-03', title: '東京散策', content: '本文' }, keys: ['lifelog'] },
  { operation: 'lifelog_get', method: 'GET', template: '/v1/lifelogs/{id}', path: withId('/v1/lifelogs', LIFELOG_ID), status: 200, expectedCall: () => lifelog, method_: 'get', arg: LIFELOG_ID, keys: ['lifelog', 'content'] },
  { operation: 'lifelog_append', method: 'POST', template: '/v1/lifelogs/{id}/append', path: withId('/v1/lifelogs', LIFELOG_ID, '/append'), options: { body: { content: '追記' } }, status: 200, expectedCall: () => lifelog, method_: 'append', arg: { id: LIFELOG_ID, content: '追記' }, keys: ['lifelog'] },
];

describe('the 21 operations', () => {
  it('covers every operation exactly once', () => {
    expect(cases.map((c) => c.operation).sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it.each(cases)('$operation: $method $template → $status', async (c) => {
    const result = await call(app, c.method, c.path, c.options);

    expect(result.status, result.text).toBe(c.status);
    expect(result.headers.get('content-type')).toMatch(/^application\/json/);
    expect(Object.keys(result.body).sort()).toEqual([...c.keys].sort());
    const connector = c.expectedCall()!;
    expect(connector.calls).toEqual([{ method: c.method_, arg: c.arg }]);
    await expectConformsToDocument(app, c.method, c.template, result);
  });

  it('returns exactly what the operation returns, as the MCP tool does', async () => {
    await call(app, 'POST', '/v1/tasks', { body: { title: 'a' } });
    const list = await call(app, 'GET', '/v1/tasks');
    expect(list.body).toEqual({ tasks: task.tasks });
  });

  it('declares each operation at its method and path, and nothing else', async () => {
    const document = await openApiDocument(app);
    const declared = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => `${operation.operationId} ${method.toUpperCase()} ${path}`),
    );
    expect(declared.sort()).toEqual(cases.map((c) => `${c.operation} ${c.method} ${c.template}`).sort());
  });
});
