import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObsidianKnowledgeConnector } from '../../../src/connectors/obsidian/connector.js';
import { DriveCreateLock } from '../../../src/connectors/obsidian/drive-create-lock.js';
import { DriveLifeLogStorage } from '../../../src/connectors/obsidian/drive-lifelog-storage.js';
import { DriveVaultStorage } from '../../../src/connectors/obsidian/drive-storage.js';
import { toFileName } from '../../../src/connectors/obsidian/filename.js';
import { FilesystemLifeLogStorage } from '../../../src/connectors/obsidian/filesystem-lifelog-storage.js';
import { FilesystemVaultStorage } from '../../../src/connectors/obsidian/filesystem-storage.js';
import { ObsidianLifeLogConnector } from '../../../src/connectors/obsidian/lifelog-connector.js';
import { ConflictError, NotFoundError, ProviderApiError } from '../../../src/errors.js';
import { createTestVault, KNOWLEDGE_DIR as K, LIFELOG_DIR as L } from '../../helpers/vault.js';
import { FakeDrive } from '../google-drive/fake-drive.js';

/**
 * The same operations and fixtures on both storages: knowledge IDs, external_ref, stored bytes,
 * search results and errors must not depend on how the vault is reached.
 */
interface Backend {
  knowledge: ObsidianKnowledgeConnector;
  lifelog: ObsidianLifeLogConnector;
  write(path: string, content: string | Buffer): Promise<void>;
  bytes(path: string): Promise<Buffer>;
  cleanup(): Promise<void>;
}

async function filesystemBackend(): Promise<Backend> {
  const vault = await createTestVault();
  return {
    knowledge: new ObsidianKnowledgeConnector({
      knowledgeDir: K,
      storage: new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: K, lifeLogDir: L }),
      warn: () => undefined,
    }),
    lifelog: new ObsidianLifeLogConnector({
      directory: L,
      storage: new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory: L, knowledgeDir: K }),
    }),
    async write(path, content) {
      await mkdir(dirname(vault.abs(path)), { recursive: true });
      await writeFile(vault.abs(path), content);
    },
    bytes: (path) => readFile(vault.abs(path)),
    cleanup: () => vault.cleanup(),
  };
}

async function driveBackend(): Promise<Backend> {
  const drive = new FakeDrive();
  drive.mkdirs(K);
  drive.mkdirs(L);
  const options = { api: async () => drive, vaultFolderId: drive.root, createLock: new DriveCreateLock() };
  return {
    knowledge: new ObsidianKnowledgeConnector({
      knowledgeDir: K,
      storage: new DriveVaultStorage({ ...options, knowledgeDir: K, lifeLogDir: L }),
      warn: () => undefined,
    }),
    lifelog: new ObsidianLifeLogConnector({
      directory: L,
      storage: new DriveLifeLogStorage({ ...options, directory: L, knowledgeDir: K }),
    }),
    async write(path, content) {
      drive.write(path, content);
    },
    bytes: async (path) => drive.bytes(drive.idAt(path)),
    cleanup: async () => undefined,
  };
}

const NOTE = `---
title: 手動のメモ
description: Obsidianで作ったメモ
area: work
tags:
  - distributed-systems
aliases: [keep]
---

CAP定理と PACELC の関係。
`;

describe.each([
  ['filesystem', filesystemBackend],
  ['google_drive', driveBackend],
] as const)('storage: %s', (_name, makeBackend) => {
  let b: Backend;

  beforeEach(async () => {
    b = await makeBackend();
  });

  afterEach(async () => {
    await b.cleanup();
  });

  describe('knowledge', () => {
    it('creates a note under the same ID, external_ref and bytes', async () => {
      const title = "CAP定理: 分散 システム? it's #1";
      const knowledge = await b.knowledge.create({
        title,
        description: '分散システムの基本',
        content: '本文の1行目\r\n2行目',
        area: 'personal',
        tags: ['distributed-systems', '分散'],
      });
      const file = toFileName(title);
      expect(knowledge).toMatchObject({ id: `obsidian:${K}/${file}`, external_ref: `${K}/${file}`, source: 'obsidian' });
      expect((await b.bytes(`${K}/${file}`)).toString('utf8')).toBe(
        `---\ntitle: "CAP定理: 分散 システム? it's #1"\ndescription: 分散システムの基本\narea: personal\ntags:\n  - distributed-systems\n  - 分散\n---\n\n本文の1行目\n2行目\n`,
      );
      await expect(b.knowledge.create({ title, content: 'again', area: null })).rejects.toBeInstanceOf(ConflictError);
    });

    it('searches, gets and appends notes made in Obsidian, keeping their frontmatter and bytes', async () => {
      await b.write(`${K}/手動 メモ (1) & #x.md`, NOTE);
      await b.write(`${K}/sub/フロントマターなし.md`, 'PACELCの説明\r\n');
      const all = await b.knowledge.search({});
      expect(all.map((r) => r.id).sort()).toEqual([`obsidian:${K}/sub/フロントマターなし.md`, `obsidian:${K}/手動 メモ (1) & #x.md`]);

      const [hit] = await b.knowledge.search({ query: 'pacelc', area: 'work', tags: ['Distributed-Systems'] });
      expect(hit).toMatchObject({ id: `obsidian:${K}/手動 メモ (1) & #x.md`, title: '手動のメモ', area: 'work' });
      expect(hit!.snippet).toContain('PACELC');

      const document = await b.knowledge.get(hit!.id!);
      expect(document.content).toBe('CAP定理と PACELC の関係。\n');

      await b.knowledge.append({ id: hit!.id!, content: '追記した内容' });
      expect((await b.bytes(`${K}/手動 メモ (1) & #x.md`)).toString('utf8')).toBe(`${NOTE}\n追記した内容\n`);

      await b.knowledge.append({ id: `obsidian:${K}/sub/フロントマターなし.md`, content: 'a\nb' });
      expect((await b.bytes(`${K}/sub/フロントマターなし.md`)).toString('utf8')).toBe('PACELCの説明\r\n\r\na\r\nb\r\n');
    });

    it('reads bytes that are not UTF-8 leniently and appends without rewriting them', async () => {
      const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('本文'), Buffer.from([0xff]), Buffer.from('\n')]);
      await b.write(`${K}/bytes.md`, original);
      expect((await b.knowledge.get(`obsidian:${K}/bytes.md`)).content).toBe('本文�\n');
      await b.knowledge.append({ id: `obsidian:${K}/bytes.md`, content: '追記' });
      expect(await b.bytes(`${K}/bytes.md`)).toEqual(Buffer.concat([original, Buffer.from('\n追記\n')]));
    });

    it('does not write to a note with malformed frontmatter', async () => {
      await b.write(`${K}/bad.md`, '---\narea: nowhere\n---\nbody\n');
      await expect(b.knowledge.append({ id: `obsidian:${K}/bad.md`, content: 'x' })).rejects.toBeInstanceOf(ProviderApiError);
      expect((await b.bytes(`${K}/bad.md`)).toString('utf8')).toBe('---\narea: nowhere\n---\nbody\n');
    });

    it('reports a missing note as not found', async () => {
      await expect(b.knowledge.get(`obsidian:${K}/missing.md`)).rejects.toBeInstanceOf(NotFoundError);
      await expect(b.knowledge.append({ id: `obsidian:${K}/missing.md`, content: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('life log', () => {
    it('creates, gets and appends under the same ID and external_ref (the title made safe as a file name)', async () => {
      const created = await b.lifelog.create({ date: '2026-10-03', title: '東京散策 1', content: '浅草へ行った。' });
      expect(created).toMatchObject({
        id: 'lifelog:2026-10-03-東京散策 1.md',
        external_ref: `${L}/2026-10-03-東京散策 1.md`,
        date: '2026-10-03',
        title: '東京散策 1',
      });
      await b.lifelog.append({ id: created.id, content: '## 夕食\n\nもんじゃ焼き。' });
      expect(await b.lifelog.get(created.id)).toMatchObject({ content: '浅草へ行った。\n\n## 夕食\n\nもんじゃ焼き。\n' });
      expect((await b.bytes(`${L}/2026-10-03-東京散策 1.md`)).toString('utf8')).toBe('浅草へ行った。\n\n## 夕食\n\nもんじゃ焼き。\n');
    });

    it('reads a manual article by its exact file name and refuses one that is not UTF-8', async () => {
      await b.write(`${L}/2026-10-04-手動.md`, '﻿手動の記事\r\n');
      expect((await b.lifelog.get('lifelog:2026-10-04-手動.md')).content).toBe('手動の記事\r\n');
      await b.lifelog.append({ id: 'lifelog:2026-10-04-手動.md', content: '追記' });
      expect((await b.bytes(`${L}/2026-10-04-手動.md`)).toString('utf8')).toBe('﻿手動の記事\r\n\r\n追記\r\n');

      await b.write(`${L}/2026-10-05-sjis.md`, Buffer.from([0x82, 0xa0]));
      await expect(b.lifelog.get('lifelog:2026-10-05-sjis.md')).rejects.toBeInstanceOf(ProviderApiError);
      await expect(b.lifelog.append({ id: 'lifelog:2026-10-05-sjis.md', content: 'x' })).rejects.toBeInstanceOf(
        ProviderApiError,
      );
      expect(await b.bytes(`${L}/2026-10-05-sjis.md`)).toEqual(Buffer.from([0x82, 0xa0]));
    });
  });
});
