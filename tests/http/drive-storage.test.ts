import { beforeEach, describe, expect, it } from 'vitest';
import { ObsidianKnowledgeConnector } from '../../src/connectors/obsidian/connector.js';
import { DriveCreateLock } from '../../src/connectors/obsidian/drive-create-lock.js';
import { DriveLifeLogStorage } from '../../src/connectors/obsidian/drive-lifelog-storage.js';
import { DriveVaultStorage } from '../../src/connectors/obsidian/drive-storage.js';
import { ObsidianLifeLogConnector } from '../../src/connectors/obsidian/lifelog-connector.js';
import { MissingCredentialError, PROVIDER_TEXT_OMITTED } from '../../src/errors.js';
import { FakeDrive, googleError } from '../connectors/google-drive/fake-drive.js';
import {
  FakeAreaConnector,
  FakeCollectionConnector,
  FakeProjectConnector,
  FakeScheduleConnector,
  FakeTaskConnector,
} from '../helpers/fake-connectors.js';
import { call, createTestApp, type TestApp, withId } from '../helpers/http.js';

/**
 * AC-D01 / AC-D04: with the vault in Google Drive, the knowledge and life log endpoints work as
 * they do on the file system — no local vault — and Drive failures follow the HTTP error rules.
 */
const K = 'AI Foundation/Knowledge';
const L = 'AI Foundation/LifeLog';
const SDK_TEXT = 'SECRET-sdk-text ya29.a0-token';

let drive: FakeDrive;
let app: TestApp;
let errors: unknown[];

function appWith(api: () => Promise<FakeDrive>): TestApp {
  const createLock = new DriveCreateLock();
  const options = { api, vaultFolderId: drive.root, createLock };
  errors = [];
  return createTestApp(
    {
      task: new FakeTaskConnector(),
      schedule: new FakeScheduleConnector(),
      collection: new FakeCollectionConnector(),
      knowledge: new ObsidianKnowledgeConnector({
        knowledgeDir: K,
        storage: new DriveVaultStorage({ ...options, knowledgeDir: K, lifeLogDir: L }),
        warn: () => undefined,
      }),
      project: new FakeProjectConnector(),
      area: new FakeAreaConnector(),
      lifelog: new ObsidianLifeLogConnector({
        directory: L,
        storage: new DriveLifeLogStorage({ ...options, directory: L, knowledgeDir: K }),
      }),
    },
    { errors },
  );
}

beforeEach(() => {
  drive = new FakeDrive();
  drive.mkdirs(K);
  drive.mkdirs(L);
  app = appWith(async () => drive);
});

describe('knowledge in Google Drive', () => {
  it('creates, searches, gets and appends through the REST API', async () => {
    const created = await call(app, 'POST', '/v1/knowledge', {
      body: { title: 'CAP定理', content: '一貫性・可用性・分断耐性', area: 'work', tags: ['db'] },
    });
    expect(created.status).toBe(201);
    const id = created.body.knowledge.id;
    expect(id).toBe(`obsidian:${K}/CAP定理.md`);

    const found = await call(app, 'GET', '/v1/knowledge', { query: { query: '可用性', tags: 'db' } });
    expect(found.status).toBe(200);
    expect(found.body.items.map((item: { id: string }) => item.id)).toEqual([id]);

    const got = await call(app, 'GET', '/v1/knowledge/entry', { query: { id } });
    expect(got.status).toBe(200);
    expect(got.body.content).toBe('一貫性・可用性・分断耐性\n');

    const appended = await call(app, 'POST', '/v1/knowledge/entry/append', { query: { id }, body: { content: 'PACELC' } });
    expect(appended.status).toBe(200);
    expect(drive.text(drive.idAt(`${K}/CAP定理.md`))).toContain('一貫性・可用性・分断耐性\n\nPACELC\n');
  });

  it('answers 409 for an existing name, an ambiguous path and a change made after reading', async () => {
    drive.write(`${K}/CAP定理.md`, '既存');
    const exists = await call(app, 'POST', '/v1/knowledge', { body: { title: 'CAP定理', content: 'x' } });
    expect(exists.status).toBe(409);
    expect(exists.body.error.code).toBe('conflict');

    drive.write(`${K}/dup.md`, '1');
    drive.write(`${K}/dup.md`, '2');
    const ambiguous = await call(app, 'GET', '/v1/knowledge/entry', { query: { id: `obsidian:${K}/dup.md` } });
    expect(ambiguous.status).toBe(409);
    const search = await call(app, 'GET', '/v1/knowledge');
    expect(search.status).toBe(409);
    expect(search.body.error.message).toContain(`"obsidian:${K}/dup.md"`);

    const target = drive.write(`${K}/edited.md`, 'body\n');
    drive.before = (method) => {
      if (method === 'updateContent') drive.externalUpdate(target, 'body\nedited elsewhere\n');
    };
    const changed = await call(app, 'POST', '/v1/knowledge/entry/append', {
      query: { id: `obsidian:${K}/edited.md` },
      body: { content: 'x' },
    });
    expect(changed.status).toBe(409);
    expect(drive.text(target)).toBe('body\nedited elsewhere\n');
  });

  it('answers 404 for a missing note and 503 for a missing vault folder', async () => {
    const missing = await call(app, 'GET', '/v1/knowledge/entry', { query: { id: `obsidian:${K}/missing.md` } });
    expect(missing.status).toBe(404);
    drive.trashItem(drive.idAt(K));
    const unusable = await call(app, 'GET', '/v1/knowledge');
    expect(unusable.status).toBe(503);
    expect(unusable.body.error.code).toBe('configuration_error');
  });
});

describe('life logs in Google Drive', () => {
  it('creates, gets and appends through the REST API', async () => {
    const created = await call(app, 'POST', '/v1/lifelogs', { body: { date: '2026-10-03', title: '東京散策', content: '浅草' } });
    expect(created.status).toBe(201);
    const id = created.body.lifelog.id;
    expect(created.body.lifelog.external_ref).toBe(`${L}/2026-10-03-東京散策.md`);
    expect((await call(app, 'POST', withId('/v1/lifelogs', id, '/append'), { body: { content: '夕食' } })).status).toBe(200);
    const got = await call(app, 'GET', withId('/v1/lifelogs', id));
    expect(got.body.content).toBe('浅草\n\n夕食\n');
  });
});

describe('Drive failures', () => {
  it.each([
    ['missing credentials', new MissingCredentialError('Google credential is not configured: set GOOGLE_OAUTH_REFRESH_TOKEN'), 503, 'credential_missing'],
    ['a rejected refresh token', Object.assign(new Error(`invalid_grant ${SDK_TEXT}`), {}), 502, 'provider_auth_failed'],
    ['a missing Drive scope', googleError(403, 'insufficientPermissions', SDK_TEXT), 502, 'provider_auth_failed'],
    ['a rate limit', googleError(429, 'rateLimitExceeded', SDK_TEXT), 502, 'provider_error'],
    ['a server error', googleError(500, undefined, SDK_TEXT), 502, 'provider_error'],
  ] as const)('maps %s without SDK text or IDs', async (_label, error, status, code) => {
    if (error instanceof MissingCredentialError) {
      app = appWith(async () => {
        throw error;
      });
    } else {
      drive.before = () => {
        throw error;
      };
    }
    for (const response of [
      await call(app, 'GET', '/v1/knowledge'),
      await call(app, 'GET', withId('/v1/lifelogs', 'lifelog:2026-10-03-東京散策.md')),
    ]) {
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.text).not.toContain(SDK_TEXT);
      expect(response.text).not.toContain(drive.root);
      if (code !== 'credential_missing' && !response.body.error.message.includes('invalid_grant')) {
        expect(response.text.includes(PROVIDER_TEXT_OMITTED) || response.text.includes('rate limit')).toBe(true);
      }
    }
    // 5xx answers are logged as one line each; nothing became an internal error (500).
    expect(errors.filter((error) => typeof error !== 'string')).toEqual([]);
  });
});
