import { mkdir, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObsidianKnowledgeConnector } from '../../../src/connectors/obsidian/connector.js';
import { FilesystemVaultStorage } from '../../../src/connectors/obsidian/filesystem-storage.js';
import type { KnowledgeCreate } from '../../../src/connectors/types.js';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../../src/errors.js';
import { createTestVault, KNOWLEDGE_DIR, linkDirectory, type TestVault } from '../../helpers/vault.js';

const id = (rest: string) => `obsidian:${KNOWLEDGE_DIR}/${rest}`;
const k = (rest: string) => `${KNOWLEDGE_DIR}/${rest}`;

let vault: TestVault;
let warnings: string[];
let connector: ObsidianKnowledgeConnector;

function connectorFor(vaultPath: string | undefined, knowledgeDir: string | undefined) {
  return new ObsidianKnowledgeConnector({
    knowledgeDir,
    storage: new FilesystemVaultStorage({ vaultPath, knowledgeDir }),
    warn: (message) => warnings.push(message),
  });
}

beforeEach(async () => {
  vault = await createTestVault();
  warnings = [];
  connector = connectorFor(vault.vault, KNOWLEDGE_DIR);
});

afterEach(async () => {
  await vault.cleanup();
});

async function expectError(action: Promise<unknown>, type: new (...args: never[]) => Error): Promise<string> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error).toBeInstanceOf(type);
  for (const secret of vault.secrets) expect(error!.message).not.toContain(secret);
  return error!.message;
}

const cap: KnowledgeCreate = {
  title: 'CAP定理',
  description: 'CAP定理と分散システムでの考え方',
  content: 'CAP定理では一貫性・可用性・分断耐性のうち2つまでしか同時に満たせない。',
  area: 'personal',
  tags: ['database', 'distributed-systems'],
};

describe('create', () => {
  it('writes a Markdown file with frontmatter directly under knowledge_dir and returns its metadata', async () => {
    const knowledge = await connector.create(cap);
    expect(knowledge).toEqual({
      id: id('CAP定理.md'),
      type: 'knowledge',
      title: 'CAP定理',
      description: 'CAP定理と分散システムでの考え方',
      source: 'obsidian',
      external_ref: k('CAP定理.md'),
      area: 'personal',
      tags: ['database', 'distributed-systems'],
    });
    expect(await vault.read(k('CAP定理.md'))).toBe(
      '---\ntitle: CAP定理\ndescription: CAP定理と分散システムでの考え方\narea: personal\n' +
        'tags:\n  - database\n  - distributed-systems\n---\n\n' +
        'CAP定理では一貫性・可用性・分断耐性のうち2つまでしか同時に満たせない。\n',
    );
  });

  it('writes LF line endings and leaves out empty keys', async () => {
    await connector.create({ title: 'メモ', content: 'line 1\r\nline 2', area: null });
    expect(await vault.read(k('メモ.md'))).toBe('---\ntitle: メモ\n---\n\nline 1\nline 2\n');
  });

  it('turns the title into a safe file name and keeps the title as given', async () => {
    const knowledge = await connector.create({ title: 'RAG: 構成と役割', content: 'x', area: null });
    expect(knowledge.id).toBe(id('RAG 構成と役割.md'));
    expect(knowledge.title).toBe('RAG: 構成と役割');
    expect((await connector.get(knowledge.id!)).knowledge.title).toBe('RAG: 構成と役割');
  });

  it('never overwrites a file with the same name', async () => {
    await connector.create(cap);
    const before = await vault.read(k('CAP定理.md'));
    const message = await expectError(connector.create({ ...cap, content: 'overwrite?' }), InputValidationError);
    expect(message).toContain(id('CAP定理.md'));
    expect(message).toContain('knowledge_append');
    expect(await vault.read(k('CAP定理.md'))).toBe(before);
  });

  it('creates at the top level even when a subfolder has a note with the same name', async () => {
    await vault.write(k('Distributed/CAP定理.md'), 'old');
    expect((await connector.create(cap)).id).toBe(id('CAP定理.md'));
  });

  it.each([['1984'], ['#ai'], ['distributed systems'], ['c++']])(
    'rejects the invalid Obsidian tag %j without creating a file',
    async (tag) => {
      await expectError(connector.create({ ...cap, tags: ['ok', tag] }), InputValidationError);
      expect(await readdir(vault.abs(KNOWLEDGE_DIR))).toEqual([]);
    },
  );

  it('rejects a title that cannot become a file name', async () => {
    await expectError(connector.create({ ...cap, title: '???' }), InputValidationError);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await connector.create(cap);
    await vault.write(
      k('AI/RAG.md'),
      '---\ntitle: RAG\ndescription: RAGの構成と役割についての学習メモ\narea: work\ntags: [ai, rag]\n---\n\n' +
        'RAGでは検索した外部知識をLLMのプロンプトに加える。\n',
    );
    await vault.write(k('Finance/深い/リスク中立確率.md'), '# リスク中立確率\n\nFrontmatterのない人間のメモ。CAPとは無関係。\n');
    await vault.write(k('.archive/古いメモ.md'), '---\ntags: [archive]\n---\n昔の内容\n');
    await vault.write(k('notes.txt'), 'CAP');
    await vault.write('Daily/2026-10-15.md', 'CAP定理 outside the knowledge directory');
  });

  it('lists every note under knowledge_dir recursively with an empty filter', async () => {
    const ids = (await connector.search({})).map((item) => item.id).sort();
    expect(ids).toEqual(
      [id('.archive/古いメモ.md'), id('AI/RAG.md'), id('CAP定理.md'), id('Finance/深い/リスク中立確率.md')].sort(),
    );
  });

  it('returns metadata and a snippet, not the full body', async () => {
    const [rag] = await connector.search({ query: 'プロンプト' });
    expect(rag).toEqual({
      id: id('AI/RAG.md'),
      type: 'knowledge',
      title: 'RAG',
      description: 'RAGの構成と役割についての学習メモ',
      source: 'obsidian',
      external_ref: k('AI/RAG.md'),
      area: 'work',
      tags: ['ai', 'rag'],
      snippet: 'RAGでは検索した外部知識をLLMのプロンプトに加える。',
    });
    expect(rag).not.toHaveProperty('content');
  });

  it('maps a note without frontmatter to defaults', async () => {
    const [note] = await connector.search({ query: '人間のメモ' });
    expect(note).toMatchObject({ title: 'リスク中立確率', description: null, area: null, tags: [] });
  });

  it.each([
    ['title', 'cap定理', ['CAP定理.md']],
    ['description', '学習メモ', ['AI/RAG.md']],
    ['tag', 'DISTRIBUTED', ['CAP定理.md']],
    ['body', 'cap', ['CAP定理.md', 'Finance/深い/リスク中立確率.md']],
  ])('finds the query in the %s', async (_label, query, expected) => {
    const ids = (await connector.search({ query })).map((item) => item.id).sort();
    expect(ids).toEqual(expected.map(id).sort());
  });

  it('filters by area and tags', async () => {
    expect((await connector.search({ area: 'work' })).map((item) => item.id)).toEqual([id('AI/RAG.md')]);
    expect((await connector.search({ area: null })).map((item) => item.id).sort()).toEqual(
      [id('.archive/古いメモ.md'), id('Finance/深い/リスク中立確率.md')].sort(),
    );
    expect((await connector.search({ tags: ['AI', 'rag'] })).map((item) => item.id)).toEqual([id('AI/RAG.md')]);
    expect(await connector.search({ tags: ['ai', 'database'] })).toEqual([]);
  });

  it('rejects an invalid tag in the filter', async () => {
    await expectError(connector.search({ tags: ['#ai'] }), InputValidationError);
  });

  it('returns the most recently modified first', async () => {
    await utimes(vault.abs(k('CAP定理.md')), new Date('2026-01-01'), new Date('2026-01-01'));
    await utimes(vault.abs(k('AI/RAG.md')), new Date('2026-06-01'), new Date('2026-06-01'));
    const ids = (await connector.search({ query: 'r' })).map((item) => item.id);
    expect(ids.indexOf(id('AI/RAG.md'))).toBeLessThan(ids.indexOf(id('CAP定理.md')));
  });

  it('skips malformed notes, reports them and keeps searching', async () => {
    await vault.write(k('broken.md'), '---\ntitle: [unclosed\n---\nCAP\n');
    await vault.write(k('AI/bad-tags.md'), '---\ntags: ["#ai"]\n---\nCAP\n');
    const ids = (await connector.search({ query: 'cap' })).map((item) => item.id).sort();
    expect(ids).toEqual([id('CAP定理.md'), id('Finance/深い/リスク中立確率.md')].sort());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipped 2 file\(s\) with malformed frontmatter/);
    expect(warnings[0]).toContain(k('broken.md'));
    for (const secret of vault.secrets) expect(warnings[0]).not.toContain(secret);
  });

  it('does not follow a directory link inside knowledge_dir', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'CAP secret');
    await linkDirectory(vault.outside, vault.abs(k('linked')));
    const ids = (await connector.search({ query: 'secret' })).map((item) => item.id);
    expect(ids).toEqual([]);
  });

  it('returns ids that get and append accept, including dot-prefixed folders', async () => {
    for (const item of await connector.search({})) {
      await expect(connector.get(item.id!)).resolves.toMatchObject({ knowledge: { id: item.id } });
      await expect(connector.append({ id: item.id!, content: '追記' })).resolves.toMatchObject({ id: item.id });
    }
  });
});

describe('get', () => {
  it('returns the metadata and the full body', async () => {
    await connector.create(cap);
    expect(await connector.get(id('CAP定理.md'))).toEqual({
      knowledge: expect.objectContaining({ id: id('CAP定理.md'), title: 'CAP定理', tags: cap.tags }),
      content: `${cap.content}\n`,
    });
  });

  it('reads a note without frontmatter', async () => {
    await vault.write(k('手書き.md'), '# 見出し\n本文\n');
    expect(await connector.get(id('手書き.md'))).toEqual({
      knowledge: expect.objectContaining({ title: '手書き', description: null, area: null, tags: [] }),
      content: '# 見出し\n本文\n',
    });
  });

  it('ignores unknown frontmatter keys', async () => {
    await vault.write(k('extra.md'), '---\ntitle: Extra\naliases: [x]\ncreated: 2026-10-15\n---\n\nbody\n');
    expect(await connector.get(id('extra.md'))).toMatchObject({ knowledge: { title: 'Extra' }, content: 'body\n' });
  });

  it('fails for malformed frontmatter without repairing it', async () => {
    const text = '---\ntitle: a\narea: study\n---\nbody\n';
    await vault.write(k('bad.md'), text);
    const message = await expectError(connector.get(id('bad.md')), ProviderApiError);
    expect(message).toMatch(/Obsidian API error: the frontmatter of .*bad\.md" is malformed \(area/);
    expect(await vault.read(k('bad.md'))).toBe(text);
  });

  it.each([
    ['a traversal', id('../secret.md')],
    ['an absolute path', 'obsidian:C:/Users/me/secret.md'],
    ['a non-Markdown file', id('notes.txt')],
    ['another vault folder', 'obsidian:Daily/2026-10-15.md'],
    ['a title instead of an id', 'CAP定理'],
  ])('rejects %s', async (_label, badId) => {
    await vault.write('secret.md', 'secret');
    await vault.write(k('notes.txt'), 'x');
    await expectError(connector.get(badId), InputValidationError);
  });

  it('rejects a path through a directory link', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkDirectory(vault.outside, vault.abs(k('linked')));
    await expectError(connector.get(id('linked/secret.md')), InputValidationError);
  });

  it('sees external edits on the next call', async () => {
    await connector.create(cap);
    expect((await connector.get(id('CAP定理.md'))).knowledge.area).toBe('personal');
    await vault.write(k('CAP定理.md'), '---\ntitle: CAP定理（改）\narea: work\n---\n\n書き換えた本文\n');
    expect(await connector.get(id('CAP定理.md'))).toMatchObject({
      knowledge: { title: 'CAP定理（改）', area: 'work', tags: [] },
      content: '書き換えた本文\n',
    });
    expect((await connector.search({ query: '書き換えた' })).map((item) => item.id)).toEqual([id('CAP定理.md')]);
  });
});

describe('append', () => {
  it('appends to the end of the body as a new paragraph and keeps the frontmatter byte for byte', async () => {
    const original = '---\ntitle: CAP定理\nunknown_key: keep me\ntags: [database]\n---\n\nCAP定理では……\n';
    await vault.write(k('CAP定理.md'), original);
    const knowledge = await connector.append({ id: id('CAP定理.md'), content: 'PACELCについても関連して調べた。' });
    expect(knowledge).toMatchObject({ id: id('CAP定理.md'), title: 'CAP定理', tags: ['database'] });
    expect(await vault.read(k('CAP定理.md'))).toBe(`${original}\nPACELCについても関連して調べた。\n`);
  });

  it('adds only the line breaks that are needed and nothing else', async () => {
    await vault.write(k('a.md'), 'no final newline');
    await connector.append({ id: id('a.md'), content: '## 自分で書いた見出し' });
    await connector.append({ id: id('a.md'), content: '- item\n' });
    expect(await vault.read(k('a.md'))).toBe('no final newline\n\n## 自分で書いた見出し\n\n- item\n');
  });

  it('keeps CRLF files consistent', async () => {
    await vault.write(k('win.md'), '---\r\ntitle: win\r\n---\r\n\r\nbody\r\n');
    await connector.append({ id: id('win.md'), content: 'a\nb' });
    expect(await vault.read(k('win.md'))).toBe('---\r\ntitle: win\r\n---\r\n\r\nbody\r\n\r\na\r\nb\r\n');
  });

  it('appends to a note without frontmatter', async () => {
    await vault.write(k('日本語のメモ.md'), '本文\n');
    await connector.append({ id: id('日本語のメモ.md'), content: '追記' });
    expect(await vault.read(k('日本語のメモ.md'))).toBe('本文\n\n追記\n');
  });

  it('does not write to a note with malformed frontmatter', async () => {
    const text = '---\ntitle: a\nbody without closing\n';
    await vault.write(k('bad.md'), text);
    await expectError(connector.append({ id: id('bad.md'), content: 'x' }), ProviderApiError);
    expect(await vault.read(k('bad.md'))).toBe(text);
  });

  it.each([
    ['a traversal', id('../../secret.md')],
    ['a non-Markdown file', id('secret.txt')],
  ])('rejects %s and changes nothing', async (_label, badId) => {
    await vault.write('secret.md', 'secret');
    await vault.write(k('secret.txt'), 'secret');
    await expectError(connector.append({ id: badId, content: 'x' }), InputValidationError);
    expect(await vault.read('secret.md')).toBe('secret');
    expect(await vault.read(k('secret.txt'))).toBe('secret');
  });

  it('rejects a path through a directory link and changes nothing', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkDirectory(vault.outside, vault.abs(k('linked')));
    await expectError(connector.append({ id: id('linked/secret.md'), content: 'x' }), InputValidationError);
    expect(await vault.read('../outside/secret.md')).toBe('secret');
  });
});

describe('names starting with ".." (not parent directories)', () => {
  it('searches, gets and appends ..note.md and ..archive/note.md', async () => {
    await vault.write(k('normal.md'), 'normal\n');
    await vault.write(k('..note.md'), '---\ntitle: dots\n---\n\nfile\n');
    await vault.write(k('..archive/note.md'), 'archived\n');

    const ids = (await connector.search({})).map((item) => item.id).sort();
    expect(ids).toEqual([id('..archive/note.md'), id('..note.md'), id('normal.md')].sort());

    expect(await connector.get(id('..note.md'))).toMatchObject({ knowledge: { title: 'dots' }, content: 'file\n' });
    expect((await connector.get(id('..archive/note.md'))).content).toBe('archived\n');
    await connector.append({ id: id('..note.md'), content: 'more' });
    await connector.append({ id: id('..archive/note.md'), content: 'more' });
    expect(await vault.read(k('..note.md'))).toBe('---\ntitle: dots\n---\n\nfile\n\nmore\n');
    expect(await vault.read(k('..archive/note.md'))).toBe('archived\n\nmore\n');
  });
});

describe('external moves and deletes', () => {
  it('reports the old id as not found after a move and finds the note under its new id', async () => {
    await connector.create(cap);
    await mkdir(vault.abs(k('Distributed Systems')));
    await rename(vault.abs(k('CAP定理.md')), vault.abs(k('Distributed Systems/CAP定理.md')));

    const message = await expectError(connector.get(id('CAP定理.md')), NotFoundError);
    expect(message).toMatch(/moved or deleted.*knowledge_search/);
    await expectError(connector.append({ id: id('CAP定理.md'), content: 'x' }), NotFoundError);
    expect((await connector.search({ query: 'CAP' })).map((item) => item.id)).toEqual([
      id('Distributed Systems/CAP定理.md'),
    ]);
    expect(await readdir(vault.abs(KNOWLEDGE_DIR))).toEqual(['Distributed Systems']);
  });

  it('reports a deleted note as not found for get and append without recreating it', async () => {
    await connector.create(cap);
    await rm(vault.abs(k('CAP定理.md')));
    await expectError(connector.get(id('CAP定理.md')), NotFoundError);
    await expectError(connector.append({ id: id('CAP定理.md'), content: 'x' }), NotFoundError);
    expect(await readdir(vault.abs(KNOWLEDGE_DIR))).toEqual([]);
  });
});

describe('configuration', () => {
  it.each([
    ['knowledge_dir', () => connectorFor('/vault', undefined), /knowledge_dir is not set/],
    ['vault_path', () => connectorFor(undefined, KNOWLEDGE_DIR), /vault_path is not set/],
  ])('reports a missing %s as a configuration error', async (_label, make, message) => {
    const unconfigured = make();
    for (const action of [
      () => unconfigured.create(cap),
      () => unconfigured.search({}),
      () => unconfigured.get(id('a.md')),
      () => unconfigured.append({ id: id('a.md'), content: 'x' }),
    ]) {
      expect(await expectError(action(), ConfigurationError)).toMatch(message);
    }
  });

  it('refuses a knowledge_dir that is a link out of the vault, for every operation', async () => {
    await linkDirectory(vault.outside, vault.abs('Linked'));
    await writeFile(join(vault.outside, 'a.md'), 'outside');
    const linked = connectorFor(vault.vault, 'Linked');
    for (const action of [
      () => linked.create(cap),
      () => linked.search({}),
      () => linked.get('obsidian:Linked/a.md'),
      () => linked.append({ id: 'obsidian:Linked/a.md', content: 'x' }),
    ]) {
      await expectError(action(), ConfigurationError);
    }
    expect(await readdir(vault.outside)).toEqual(['a.md']);
  });
});
