import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObsidianKnowledgeConnector } from '../../../src/connectors/obsidian/connector.js';
import { FilesystemLifeLogStorage } from '../../../src/connectors/obsidian/filesystem-lifelog-storage.js';
import { FilesystemVaultStorage } from '../../../src/connectors/obsidian/filesystem-storage.js';
import { ObsidianLifeLogConnector } from '../../../src/connectors/obsidian/lifelog-connector.js';
import type { LifeLogStorage } from '../../../src/connectors/obsidian/lifelog-storage.js';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../../src/errors.js';
import { createTestVault, KNOWLEDGE_DIR, LIFELOG_DIR, type TestVault } from '../../helpers/vault.js';

const l = (name: string) => `${LIFELOG_DIR}/${name}`;

let vault: TestVault;
let storage: FilesystemLifeLogStorage;
let connector: ObsidianLifeLogConnector;

beforeEach(async () => {
  vault = await createTestVault();
  storage = new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory: LIFELOG_DIR });
  connector = new ObsidianLifeLogConnector({ directory: LIFELOG_DIR, storage });
});

afterEach(async () => {
  await vault.cleanup();
});

async function expectError(action: Promise<unknown>, type: new (...args: never[]) => Error): Promise<Error> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error).toBeInstanceOf(type);
  for (const secret of vault.secrets) expect(error!.message).not.toContain(secret);
  return error!;
}

/** Every file below `dir` with its bytes, to show that nothing there changed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(vault.abs(dir), { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files[path] = (await readFile(path)).toString('base64');
  }
  return files;
}

describe('create → get → append', () => {
  it('creates an article, gets it by the returned id and appends without losing the body', async () => {
    const created = await connector.create({ date: '2026-10-03', title: '東京散策', content: '# 東京散策\n\n浅草へ行った。' });
    expect(created).toEqual({
      id: 'lifelog:2026-10-03-東京散策.md',
      type: 'lifelog',
      date: '2026-10-03',
      title: '東京散策',
      source: 'obsidian',
      external_ref: `${LIFELOG_DIR}/2026-10-03-東京散策.md`,
    });

    expect(await connector.get(created.id)).toEqual({ lifelog: created, content: '# 東京散策\n\n浅草へ行った。\n' });

    expect(await connector.append({ id: created.id, content: '## 夕食\n\nもんじゃ焼き。' })).toEqual(created);
    expect((await connector.get(created.id)).content).toBe('# 東京散策\n\n浅草へ行った。\n\n## 夕食\n\nもんじゃ焼き。\n');
  });

  it('saves the content as given: no frontmatter, heading or date, only LF line endings and a final newline', async () => {
    await connector.create({ date: '2026-10-03', title: 'メモ', content: '一行目\r\n二行目\r三行目' });
    expect(await vault.read(l('2026-10-03-メモ.md'))).toBe('一行目\n二行目\n三行目\n');
  });

  it('returns the title as the file name has it, the same as lifelog_get', async () => {
    const created = await connector.create({ date: '2026-10-03', title: '東京:散策 #旅行', content: 'x' });
    expect(created.title).toBe('東京 散策 旅行');
    expect((await connector.get(created.id)).lifelog).toEqual(created);
  });

  it('keeps the line endings of a CRLF file and writes valid UTF-8', async () => {
    await writeFile(vault.abs(l('2026-10-03-crlf.md')), '本文\r\n');
    await connector.append({ id: 'lifelog:2026-10-03-crlf.md', content: '追記 😀\n𠮷' });
    const bytes = await readFile(vault.abs(l('2026-10-03-crlf.md')));
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe('本文\r\n\r\n追記 😀\r\n𠮷\r\n');
  });
});

describe('same day, same name', () => {
  it('saves several articles on the same day under different titles', async () => {
    const a = await connector.create({ date: '2026-10-03', title: '東京散策', content: 'a' });
    const b = await connector.create({ date: '2026-10-03', title: '夜の飲み会', content: 'b' });
    expect(a.id).not.toBe(b.id);
    expect((await readdir(vault.abs(LIFELOG_DIR))).sort()).toEqual(['2026-10-03-夜の飲み会.md', '2026-10-03-東京散策.md']);
  });

  it('refuses the same date and title, leaving the existing article byte for byte', async () => {
    await connector.create({ date: '2026-10-03', title: '東京散策', content: '元の本文' });
    const before = await readFile(vault.abs(l('2026-10-03-東京散策.md')));
    const error = await expectError(
      connector.create({ date: '2026-10-03', title: '東京散策', content: '別の本文' }),
      InputValidationError,
    );
    expect(error.message).toContain('already exists');
    expect(Buffer.compare(await readFile(vault.abs(l('2026-10-03-東京散策.md'))), before)).toBe(0);
  });

  it('refuses titles that become the same file name', async () => {
    await connector.create({ date: '2026-10-03', title: '東京 散策', content: 'a' });
    await expectError(connector.create({ date: '2026-10-03', title: '東京:散策', content: 'b' }), InputValidationError);
    expect(await vault.read(l('2026-10-03-東京 散策.md'))).toBe('a\n');
  });

  it('lets exactly one of many concurrent creates with the same name succeed', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => connector.create({ date: '2026-10-03', title: '同時', content: `本文${i}` })),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const { reason } of rejected) expect(reason).toBeInstanceOf(InputValidationError);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    expect(await vault.read(l('2026-10-03-同時.md'))).toBe(`本文${winner}\n`);
  });
});

describe('concurrent and external changes', () => {
  /**
   * Same process, small texts: what this test can show. O_APPEND does not make a whole append
   * atomic for any size or across processes (see the implementation plan §10.3).
   */
  it('keeps the body and both texts of two concurrent small appends in one process', async () => {
    const created = await connector.create({ date: '2026-10-03', title: '同時追記', content: '元の本文' });
    await Promise.all([
      connector.append({ id: created.id, content: '追記A '.repeat(50) }),
      connector.append({ id: created.id, content: '追記B '.repeat(50) }),
    ]);
    const text = await vault.read(l('2026-10-03-同時追記.md'));
    expect(text.startsWith('元の本文\n')).toBe(true);
    expect(text).toContain(`${'追記A '.repeat(50)}\n`);
    expect(text).toContain(`${'追記B '.repeat(50)}\n`);
  });

  it('does not lose text written to the end of the file between reading and appending', async () => {
    const created = await connector.create({ date: '2026-10-03', title: '外部編集', content: '元の本文' });
    const path = vault.abs(l('2026-10-03-外部編集.md'));
    const racing: LifeLogStorage = {
      refOf: (name) => storage.refOf(name),
      read: async (name) => {
        const file = await storage.read(name);
        await writeFile(path, 'Obsidianで追加\n', { flag: 'a' }); // edited in Obsidian meanwhile
        return file;
      },
      createExclusive: (name, text) => storage.createExclusive(name, text),
      append: (name, text) => storage.append(name, text),
    };
    await new ObsidianLifeLogConnector({ directory: LIFELOG_DIR, storage: racing }).append({
      id: created.id,
      content: 'AIから追記',
    });
    expect(await readFile(path, 'utf8')).toBe('元の本文\nObsidianで追加\n\nAIから追記\n');
  });

  it('reports a failed write and leaves the existing body as it was', async () => {
    const created = await connector.create({ date: '2026-10-03', title: '書き込み失敗', content: '元の本文' });
    const failing: LifeLogStorage = {
      refOf: (name) => storage.refOf(name),
      read: (name) => storage.read(name),
      createExclusive: (name, text) => storage.createExclusive(name, text),
      append: async () => {
        throw new ProviderApiError('Obsidian', 'cannot write "lifelog:2026-10-03-書き込み失敗.md" (ENOSPC)');
      },
    };
    await expectError(
      new ObsidianLifeLogConnector({ directory: LIFELOG_DIR, storage: failing }).append({ id: created.id, content: 'x' }),
      ProviderApiError,
    );
    expect(await vault.read(l('2026-10-03-書き込み失敗.md'))).toBe('元の本文\n');
  });

  it('does not recreate an article deleted or renamed in Obsidian', async () => {
    const created = await connector.create({ date: '2026-10-03', title: '消える', content: 'x' });
    await rename(vault.abs(l('2026-10-03-消える.md')), vault.abs(l('2026-10-03-改名.md')));
    expect((await expectError(connector.get(created.id), NotFoundError)).message).toContain('renamed, moved or deleted');
    await expectError(connector.append({ id: created.id, content: 'y' }), NotFoundError);
    await rm(vault.abs(l('2026-10-03-改名.md')));
    await expectError(connector.append({ id: created.id, content: 'y' }), NotFoundError);
    expect(await readdir(vault.abs(LIFELOG_DIR))).toEqual([]);
  });
});

describe('articles created by hand in Obsidian', () => {
  it('gets and appends to a file that follows the naming rule, with or without frontmatter', async () => {
    await vault.write(l('2026-10-05-鎌倉.md'), '---\ntags: [旅行]\n---\n大仏を見た。\n');
    await vault.write(l('2026-10-06-#手動.md'), '手で書いた');

    const doc = await connector.get('lifelog:2026-10-05-鎌倉.md');
    expect(doc).toEqual({
      lifelog: {
        id: 'lifelog:2026-10-05-鎌倉.md',
        type: 'lifelog',
        date: '2026-10-05',
        title: '鎌倉',
        source: 'obsidian',
        external_ref: `${LIFELOG_DIR}/2026-10-05-鎌倉.md`,
      },
      content: '---\ntags: [旅行]\n---\n大仏を見た。\n',
    });
    await connector.append({ id: 'lifelog:2026-10-05-鎌倉.md', content: '帰りに江ノ島。' });
    expect(await vault.read(l('2026-10-05-鎌倉.md'))).toBe('---\ntags: [旅行]\n---\n大仏を見た。\n\n帰りに江ノ島。\n');

    // Sanitizing applies to new names only: an existing name is used as it is.
    expect((await connector.get('lifelog:2026-10-06-#手動.md')).lifelog.title).toBe('#手動');
  });

  it.each(['鎌倉旅行.md', '2026-10-5-鎌倉.md', '2026-02-30-鎌倉.md', '2026-10-05-鎌倉.MD'])(
    'cannot address %j, which does not follow the naming rule',
    async (name) => {
      await vault.write(l(name), 'x');
      await expectError(connector.get(`lifelog:${name}`), InputValidationError);
      await expectError(connector.append({ id: `lifelog:${name}`, content: 'y' }), InputValidationError);
      expect(await vault.read(l(name))).toBe('x');
    },
  );

  it('cannot address an article in a subdirectory', async () => {
    await vault.write(l('2026/2026-10-05-鎌倉.md'), 'x');
    await expectError(connector.get('lifelog:2026/2026-10-05-鎌倉.md'), InputValidationError);
  });

  it('refuses to create an article with the name of one written by hand', async () => {
    await vault.write(l('2026-10-05-鎌倉.md'), '手書き');
    await expectError(connector.create({ date: '2026-10-05', title: '鎌倉', content: 'x' }), InputValidationError);
    expect(await vault.read(l('2026-10-05-鎌倉.md'))).toBe('手書き');
  });
});

describe('text that is not UTF-8', () => {
  it('fails to get or append, and leaves the bytes as they were', async () => {
    const bytes = Buffer.from([0x93, 0x8c, 0x8b, 0x9e, 0x0a]); // Shift_JIS
    await writeFile(vault.abs(l('2026-10-03-sjis.md')), bytes);
    await expectError(connector.get('lifelog:2026-10-03-sjis.md'), ProviderApiError);
    await expectError(connector.append({ id: 'lifelog:2026-10-03-sjis.md', content: 'x' }), ProviderApiError);
    expect(Buffer.compare(await readFile(vault.abs(l('2026-10-03-sjis.md'))), bytes)).toBe(0);
  });
});

describe('independence from knowledge', () => {
  it('never changes the knowledge directory, and knowledge_search never sees life logs', async () => {
    await vault.write(`${KNOWLEDGE_DIR}/CAP定理.md`, '---\ntitle: CAP定理\n---\n本文\n');
    const before = await snapshot(KNOWLEDGE_DIR);
    const mtime = (await stat(vault.abs(`${KNOWLEDGE_DIR}/CAP定理.md`))).mtimeMs;

    const created = await connector.create({ date: '2026-10-03', title: 'CAP定理', content: 'lifelog-marker' });
    await connector.append({ id: created.id, content: 'lifelog-marker 2' });

    expect(await snapshot(KNOWLEDGE_DIR)).toEqual(before);
    expect((await stat(vault.abs(`${KNOWLEDGE_DIR}/CAP定理.md`))).mtimeMs).toBe(mtime);
    const knowledge = new ObsidianKnowledgeConnector({
      knowledgeDir: KNOWLEDGE_DIR,
      storage: new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: KNOWLEDGE_DIR }),
    });
    expect(await knowledge.search({ query: 'lifelog-marker' })).toEqual([]);
  });

  it('rejects knowledge ids and paths into the knowledge directory', async () => {
    await vault.write(`${KNOWLEDGE_DIR}/2026-10-03-x.md`, 'knowledge');
    for (const id of [
      `obsidian:${KNOWLEDGE_DIR}/2026-10-03-x.md`,
      `lifelog:${KNOWLEDGE_DIR}/2026-10-03-x.md`,
      'lifelog:../Knowledge/2026-10-03-x.md',
    ]) {
      await expectError(connector.get(id), InputValidationError);
      await expectError(connector.append({ id, content: 'x' }), InputValidationError);
    }
    expect(await vault.read(`${KNOWLEDGE_DIR}/2026-10-03-x.md`)).toBe('knowledge');
  });
});

describe('configuration', () => {
  it('needs the directory and the vault, and creates neither', async () => {
    const noDir = new ObsidianLifeLogConnector({ directory: undefined, storage });
    const error = await expectError(noDir.create({ date: '2026-10-03', title: 'x', content: 'x' }), ConfigurationError);
    expect(error.message).toContain('sources.lifelog.obsidian.directory is not set');
    await expectError(noDir.get('lifelog:2026-10-03-x.md'), ConfigurationError);

    const noVault = new ObsidianLifeLogConnector({
      directory: LIFELOG_DIR,
      storage: new FilesystemLifeLogStorage({ vaultPath: undefined, directory: LIFELOG_DIR }),
    });
    await expectError(noVault.create({ date: '2026-10-03', title: 'x', content: 'x' }), ConfigurationError);

    await rm(vault.abs(LIFELOG_DIR), { recursive: true });
    await expectError(connector.create({ date: '2026-10-03', title: 'x', content: 'x' }), ConfigurationError);
    expect(await readdir(vault.abs('AI Foundation'))).toEqual(['Knowledge']);
  });
});
