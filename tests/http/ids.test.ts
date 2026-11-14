import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConnectors } from '../../src/connectors/index.js';
import { EnvCredentialProvider } from '../../src/credentials/env.js';
import {
  FakeAreaConnector,
  FakeCollectionConnector,
  FakeKnowledgeConnector,
  FakeLifeLogConnector,
  FakeProjectConnector,
  FakeScheduleConnector,
  FakeTaskConnector,
} from '../helpers/fake-connectors.js';
import { call, createTestApp, withId } from '../helpers/http.js';
import { repoConfig } from '../helpers/mcp.js';
import { createTestVault, KNOWLEDGE_DIR, LIFELOG_DIR, type TestVault } from '../helpers/vault.js';

/**
 * AC-05: ids with Japanese, spaces, "/", "%", "#", "+" and "@" reach the connector exactly as
 * returned when sent the documented way (path or query, URL-encoded), and an id cannot reach a file
 * outside the configured directories.
 */

describe('round trip of existing ids', () => {
  let fakes: {
    task: FakeTaskConnector;
    schedule: FakeScheduleConnector;
    collection: FakeCollectionConnector;
    knowledge: FakeKnowledgeConnector;
    project: FakeProjectConnector;
    area: FakeAreaConnector;
    lifelog: FakeLifeLogConnector;
  };
  let app: ReturnType<typeof createTestApp>;
  beforeEach(() => {
    fakes = {
      task: new FakeTaskConnector(),
      schedule: new FakeScheduleConnector(),
      collection: new FakeCollectionConnector(),
      knowledge: new FakeKnowledgeConnector(),
      project: new FakeProjectConnector(),
      area: new FakeAreaConnector(),
      lifelog: new FakeLifeLogConnector(),
    };
    app = createTestApp(fakes);
  });

  it.each([
    'lifelog:2026-10-03-東京 散策.md',
    'lifelog:2026-10-03-100% 達成.md',
    'lifelog:2026-10-03-a+b #1 @home.md',
    'lifelog:2026-10-03-%41%2F.md',
  ])('passes the life log id %j in the path unchanged', async (id) => {
    expect((await call(app, 'GET', withId('/v1/lifelogs', id))).status).toBe(200);
    expect((await call(app, 'POST', withId('/v1/lifelogs', id, '/append'), { body: { content: 'x' } })).status).toBe(200);
    expect(fakes.lifelog.calls.map((c) => c.arg)).toEqual([id, { id, content: 'x' }]);
  });

  it.each([
    'google_calendar:ja.japanese#holiday@group.v.calendar.google.com:abc123',
    'google_calendar:af@group.calendar.google.com:evt_20261120T050000Z',
  ])('passes the schedule id %j in the path unchanged', async (id) => {
    expect((await call(app, 'PATCH', withId('/v1/schedules', id), { body: { title: 'x' } })).status).toBe(200);
    expect(fakes.schedule.calls[0]!.arg).toEqual({ id, title: 'x' });
  });

  it('passes task, collection and area ids in the path unchanged', async () => {
    await call(app, 'PATCH', withId('/v1/tasks', 'todoist:6Xg8hP3fQ2'), { body: { title: 'x' } });
    await call(app, 'POST', withId('/v1/tasks', 'todoist:6Xg8hP3fQ2', '/complete'));
    await call(app, 'PATCH', withId('/v1/collection-items', 'notion:1f2e3d4c-5b6a-7988-1f2e-3d4c5b6a7988'), { body: { status: 'x' } });
    await call(app, 'GET', withId('/v1/areas', 'notion:1f2e3d4c5b6a79881f2e3d4c5b6a7988'));
    expect(fakes.task.calls.map((c) => c.arg)).toEqual([{ id: 'todoist:6Xg8hP3fQ2', title: 'x' }, 'todoist:6Xg8hP3fQ2']);
    expect(fakes.collection.calls[0]!.arg).toEqual({ id: 'notion:1f2e3d4c-5b6a-7988-1f2e-3d4c5b6a7988', status: 'x' });
    expect(fakes.area.calls[0]!.arg).toBe('notion:1f2e3d4c5b6a79881f2e3d4c5b6a7988');
  });

  it.each([
    `obsidian:${KNOWLEDGE_DIR}/日本語 メモ/a+b 100%.md`,
    `obsidian:${KNOWLEDGE_DIR}/C#/#tag @x?y=z&w.md`,
    `obsidian:${KNOWLEDGE_DIR}/%2F%25.md`,
  ])('passes the knowledge id %j in the query unchanged', async (id) => {
    expect((await call(app, 'GET', '/v1/knowledge/entry', { query: { id } })).status).toBe(200);
    expect((await call(app, 'POST', '/v1/knowledge/entry/append', { query: { id }, body: { content: 'x' } })).status).toBe(200);
    expect(fakes.knowledge.calls.map((c) => c.arg)).toEqual([id, { id, content: 'x' }]);
  });

  it('passes a project id with "/" in the query unchanged', async () => {
    expect((await call(app, 'GET', '/v1/projects/entry', { query: { id: 'github:my-org/repo.name_1' } })).status).toBe(200);
    expect(fakes.project.calls[0]!.arg).toBe('github:my-org/repo.name_1');
  });

  it('reads a bare "+" in a query as a space, as documented (send %2B)', async () => {
    await call(app, 'GET', '/v1/knowledge/entry?id=obsidian:a+b.md');
    await call(app, 'GET', '/v1/knowledge/entry?id=obsidian:a%2Bb.md');
    expect(fakes.knowledge.calls.map((c) => c.arg)).toEqual(['obsidian:a b.md', 'obsidian:a+b.md']);
  });

  it('decodes once: an encoded "%2F" stays "%2F"', async () => {
    await call(app, 'GET', '/v1/lifelogs/lifelog%3A2026-10-03-%252F.md');
    expect(fakes.lifelog.calls[0]!.arg).toBe('lifelog:2026-10-03-%2F.md');
  });

  it('keeps an encoded "/" in the path inside the id, so the route does not change', async () => {
    const result = await call(app, 'GET', '/v1/areas/notion%3Aa%2Fappend');
    expect(result.status).toBe(200);
    expect(fakes.area.calls[0]!.arg).toBe('notion:a/append');
  });

  it('does not route a raw "/" in an id: the path no longer matches', async () => {
    const result = await call(app, 'GET', '/v1/lifelogs/lifelog:2026/2026-10-03-a.md');
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('route_not_found');
    expect(fakes.lifelog.calls).toEqual([]);
  });
});

describe('ids that would leave the configured directories', () => {
  let vault: TestVault;
  let app: ReturnType<typeof createTestApp>;
  const SENTINEL = 'SENTINEL-outside-the-vault';

  beforeEach(async () => {
    vault = await createTestVault();
    await writeFile(join(vault.outside, 'x.md'), SENTINEL);
    await vault.write('AI Foundation/secret.md', SENTINEL);
    await vault.write(`${KNOWLEDGE_DIR}/ok.md`, '---\ntitle: ok\n---\n\nok\n');
    await vault.write(`${LIFELOG_DIR}/2026-10-03-ok.md`, 'ok\n');
    const config = structuredClone(repoConfig);
    config.sources.knowledge.obsidian = { storage: 'filesystem', vault_path: vault.vault, knowledge_dir: KNOWLEDGE_DIR };
    config.sources.lifelog = { provider: 'obsidian', obsidian: { directory: LIFELOG_DIR } };
    app = createTestApp(createConnectors(config, new EnvCredentialProvider({})), { config });
  });
  afterEach(() => vault.cleanup());

  function expectRefused(result: Awaited<ReturnType<typeof call>>) {
    expect(result.status, result.text).toBe(400);
    expect(result.body.error.code).toBe('invalid_input');
    expect(result.text).not.toContain(SENTINEL);
    for (const secret of vault.secrets) expect(result.text).not.toContain(secret.replaceAll('\\', '\\\\'));
    for (const secret of vault.secrets) expect(result.text).not.toContain(secret);
  }

  it('reads the files inside (the setup works)', async () => {
    expect((await call(app, 'GET', withId('/v1/lifelogs', 'lifelog:2026-10-03-ok.md'))).status).toBe(200);
    expect((await call(app, 'GET', '/v1/knowledge/entry', { query: { id: `obsidian:${KNOWLEDGE_DIR}/ok.md` } })).status).toBe(200);
  });

  it.each([
    'lifelog:../../outside/x.md',
    'lifelog:..\\..\\outside\\x.md',
    'lifelog:../secret.md',
    'lifelog:2026-10-03-ok.md\u0000',
    'lifelog:2026-10-03-ok.md:stream',
    'lifelog:C:/x.md',
  ])('refuses the life log id %j', async (id) => {
    expectRefused(await call(app, 'GET', withId('/v1/lifelogs', id)));
    expectRefused(await call(app, 'POST', withId('/v1/lifelogs', id, '/append'), { body: { content: 'x' } }));
  });

  it('refuses a path that encodes "../" segments into the life log id', async () => {
    expectRefused(await call(app, 'GET', '/v1/lifelogs/lifelog%3A..%2F..%2Foutside%2Fx.md'));
  });

  it.each([
    `obsidian:${KNOWLEDGE_DIR}/../secret.md`,
    `obsidian:${KNOWLEDGE_DIR}/../../../outside/x.md`,
    'obsidian:AI Foundation/secret.md',
    'obsidian:C:/Windows/win.ini',
    'obsidian:/etc/passwd',
    `obsidian:${KNOWLEDGE_DIR}\\..\\secret.md`,
  ])('refuses the knowledge id %j', async (id) => {
    expectRefused(await call(app, 'GET', '/v1/knowledge/entry', { query: { id } }));
    expectRefused(await call(app, 'POST', '/v1/knowledge/entry/append', { query: { id }, body: { content: 'x' } }));
  });

  it('leaves the files outside untouched', async () => {
    await call(app, 'POST', '/v1/knowledge/entry/append', { query: { id: 'obsidian:AI Foundation/secret.md' }, body: { content: 'x' } });
    await call(app, 'POST', withId('/v1/lifelogs', 'lifelog:../secret.md', '/append'), { body: { content: 'x' } });
    expect(await vault.read('AI Foundation/secret.md')).toBe(SENTINEL);
  });
});
