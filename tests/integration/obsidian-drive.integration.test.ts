import { drive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDriveApi } from '../../src/connectors/google-drive/client.js';
import { ObsidianKnowledgeConnector } from '../../src/connectors/obsidian/connector.js';
import { DriveCreateLock } from '../../src/connectors/obsidian/drive-create-lock.js';
import { DriveLifeLogStorage } from '../../src/connectors/obsidian/drive-lifelog-storage.js';
import { DriveVaultStorage } from '../../src/connectors/obsidian/drive-storage.js';
import { ObsidianLifeLogConnector } from '../../src/connectors/obsidian/lifelog-connector.js';
import type { Knowledge } from '../../src/domain/index.js';
import { ConflictError } from '../../src/errors.js';
import { credentials, enabled, hasEnv, integrationConfig, runLabel } from './setup.js';

/**
 * Runs against a vault folder in My Drive made for testing (GOOGLE_DRIVE_IT_VAULT_FOLDER_ID), never
 * the configured vault_folder_id. Its knowledge and life log folders (the knowledge_dir and
 * directory of the config) must exist: the test does not create folders. Files this run creates
 * are moved to the trash afterwards.
 */
const vaultFolderId = process.env.GOOGLE_DRIVE_IT_VAULT_FOLDER_ID?.trim();
const run =
  enabled && !!vaultFolderId && hasEnv('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN');
const config = run ? await integrationConfig() : undefined;
const knowledgeDir = config?.sources.knowledge.obsidian?.knowledge_dir ?? 'AI Foundation/Knowledge';
const lifeLogDir = config?.sources.lifelog?.obsidian?.directory ?? 'AI Foundation/LifeLog';

describe.runIf(run)('Obsidian vault in Google Drive (real API)', () => {
  const api = async () => createDriveApi(await credentials.getGoogleOAuthCredentials());
  const createLock = new DriveCreateLock();
  const options = { api, vaultFolderId, createLock };
  const knowledge = new ObsidianKnowledgeConnector({
    knowledgeDir,
    storage: new DriveVaultStorage({ ...options, knowledgeDir, lifeLogDir }),
  });
  const lifelog = new ObsidianLifeLogConnector({
    directory: lifeLogDir,
    storage: new DriveLifeLogStorage({ ...options, directory: lifeLogDir, knowledgeDir }),
  });
  /** Unique word in every note of this run, so searches see only them. */
  const marker = `afit${Date.now()}`;
  let raw: drive_v3.Drive;
  let knowledgeFolder: string;
  let cap: Knowledge;

  /** The one folder named `name` in `parent`. */
  async function folder(parent: string, name: string): Promise<string> {
    const q = `'${parent}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
    const { data } = await raw.files.list({ q, fields: 'files(id,name)', pageSize: 1000 });
    const found = (data.files ?? []).filter((f) => f.name === name);
    if (found.length !== 1) throw new Error(`the test vault needs exactly one folder "${name}"`);
    return found[0]!.id!;
  }

  async function filesNamed(parent: string, name: string): Promise<drive_v3.Schema$File[]> {
    const q = `'${parent}' in parents and trashed = false`;
    const { data } = await raw.files.list({ q, fields: 'files(id,name,mimeType)', pageSize: 1000 });
    return (data.files ?? []).filter((f) => f.name === name);
  }

  async function text(id: string): Promise<string> {
    const res = await raw.files.get({ fileId: id, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(res.data as unknown as ArrayBuffer).toString('utf8');
  }

  beforeAll(async () => {
    const { clientId, clientSecret, refreshToken } = await credentials.getGoogleOAuthCredentials();
    const auth = new OAuth2Client({ clientId, clientSecret });
    auth.setCredentials({ refresh_token: refreshToken });
    raw = drive({ version: 'v3', auth });
    let current = vaultFolderId!;
    for (const name of knowledgeDir.split('/')) current = await folder(current, name);
    knowledgeFolder = current;
    await knowledge.search({ query: marker }); // fails early on a configuration error
  });

  afterAll(async () => {
    // The connectors never delete: move what this run created to the trash from here.
    if (!raw) return;
    const { data } = await raw.files.list({ q: `name contains '${marker}' and trashed = false`, fields: 'files(id)' });
    await Promise.allSettled((data.files ?? []).map((f) => raw.files.update({ fileId: f.id!, requestBody: { trashed: true } })));
  });

  it("creates a note Obsidian can read, under a name with Japanese, spaces and '", async () => {
    cap = await knowledge.create({
      title: `${runLabel} CAP定理 it's ${marker}`,
      description: 'CAP定理と分散システムでの考え方',
      content: `一貫性・可用性・分断耐性。${marker}`,
      area: 'personal',
      tags: ['af-it', 'distributed-systems'],
    });
    expect(cap.id).toBe(`obsidian:${cap.external_ref}`);
    const [file, ...others] = await filesNamed(knowledgeFolder, cap.external_ref.split('/').at(-1)!);
    expect(others).toHaveLength(0);
    expect(file!.mimeType).toBe('text/markdown');
    const stored = await text(file!.id!);
    expect(stored.startsWith('---\ntitle: ')).toBe(true);
    expect(stored).not.toContain('\r');
  });

  it('searches, gets and appends, keeping the frontmatter', async () => {
    const started = Date.now();
    const found = await knowledge.search({ query: marker, tags: ['AF-IT'] });
    console.info(`[af-it] knowledge_search over the test vault took ${Date.now() - started} ms`);
    expect(found.map((item) => item.id)).toEqual([cap.id]);
    const before = (await knowledge.get(cap.id!)).content;
    await knowledge.append({ id: cap.id!, content: 'PACELCについても関連して調べた。' });
    expect((await knowledge.get(cap.id!)).content).toBe(`${before}\nPACELCについても関連して調べた。\n`);
  });

  it('reads and appends to a file another client made (CRLF, text/plain), keeping its line endings and MIME type', async () => {
    const name = `手動 ${marker}.md`;
    const { data } = await raw.files.create({
      requestBody: { name, parents: [knowledgeFolder], mimeType: 'text/plain' },
      media: { mimeType: 'text/plain', body: `# 手動\r\n\r\n${marker} manual\r\n` },
      fields: 'id',
    });
    const id = `obsidian:${knowledgeDir}/${name}`;
    expect((await knowledge.search({ query: `${marker} manual` })).map((item) => item.id)).toEqual([id]);
    await knowledge.append({ id, content: '追記' });
    expect(await text(data.id!)).toBe(`# 手動\r\n\r\n${marker} manual\r\n\r\n追記\r\n`);
    const { data: meta } = await raw.files.get({ fileId: data.id!, fields: 'mimeType' });
    expect(meta.mimeType).toBe('text/plain');
  });

  it('creates only one of two concurrent creates of a name in this process', async () => {
    const title = `${runLabel} 同時 ${marker}`;
    const results = await Promise.allSettled([
      knowledge.create({ title, content: 'a', area: null }),
      knowledge.create({ title, content: 'b', area: null }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  });

  it('creates, gets and appends a life log article', async () => {
    const created = await lifelog.create({ date: '2026-10-03', title: `${marker} 東京散策`, content: '浅草へ行った。' });
    expect(created.external_ref).toBe(`${lifeLogDir}/2026-10-03-${marker} 東京散策.md`);
    await lifelog.append({ id: created.id, content: '## 夕食' });
    expect((await lifelog.get(created.id)).content).toBe('浅草へ行った。\n\n## 夕食\n');
  });
});
