import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesystemLifeLogStorage } from '../../src/connectors/obsidian/filesystem-lifelog-storage.js';
import { ObsidianLifeLogConnector } from '../../src/connectors/obsidian/lifelog-connector.js';
import type { LifeLog } from '../../src/domain/index.js';
import { InputValidationError, NotFoundError } from '../../src/errors.js';
import { enabled, integrationConfig } from './setup.js';

/**
 * Runs against the vault in sources.knowledge.obsidian and the directory in sources.lifelog
 * (config.local.yaml). Use a vault (or a life log directory) made for testing: articles are created
 * there and only the files this run created are removed afterwards.
 */
const config = enabled ? await integrationConfig() : undefined;
const vaultPath = config?.sources.knowledge.obsidian?.vault_path;
const knowledgeDir = config?.sources.knowledge.obsidian?.knowledge_dir;
const directory = config?.sources.lifelog?.obsidian?.directory;
const run = enabled && !!vaultPath && !!directory;

describe.runIf(run)('Obsidian life log (real vault)', () => {
  // The describe body runs even when skipped: read the config only when enabled.
  const connector = new ObsidianLifeLogConnector({
    directory,
    storage: new FilesystemLifeLogStorage({ vaultPath, directory }),
  });
  const abs = (path: string) => join(vaultPath ?? '', ...path.split('/'));
  /** Unique word in every article title of this run. */
  const marker = `af-it-${Date.now()}`;
  const date = '2026-10-03';
  const created: string[] = [];
  let knowledgeBefore: Record<string, number> = {};
  let article: LifeLog;

  /** Names and modification times of every file in knowledge_dir, to show it is left alone. */
  async function knowledgeFiles(): Promise<Record<string, number>> {
    if (!knowledgeDir) return {};
    const entries = await readdir(abs(knowledgeDir), { recursive: true, withFileTypes: true });
    const files: Record<string, number> = {};
    for (const entry of entries.filter((e) => e.isFile())) {
      const path = join(entry.parentPath, entry.name);
      files[path] = (await stat(path)).mtimeMs;
    }
    return files;
  }

  beforeAll(async () => {
    knowledgeBefore = await knowledgeFiles();
  });

  afterAll(async () => {
    // The connector never deletes: remove exactly the files this run created, never the directory.
    await Promise.allSettled(created.map((ref) => rm(abs(ref), { force: true })));
  });

  it('creates an article as UTF-8 with LF line endings and no frontmatter, and gets it', async () => {
    article = await connector.create({ date, title: `${marker} 東京散策`, content: '# 東京散策\r\n\r\n浅草へ行った。' });
    created.push(article.external_ref);
    expect(article).toMatchObject({ date, title: `${marker} 東京散策`, source: 'obsidian' });
    expect(article.id).toBe(`lifelog:${date}-${marker} 東京散策.md`);
    expect(article.external_ref).toBe(`${directory}/${date}-${marker} 東京散策.md`);
    expect(article.id).not.toContain(vaultPath!);

    const bytes = await readFile(abs(article.external_ref));
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe('# 東京散策\n\n浅草へ行った。\n');
    expect((await connector.get(article.id)).content).toBe('# 東京散策\n\n浅草へ行った。\n');
  });

  it('appends without losing the body', async () => {
    await connector.append({ id: article.id, content: '## 夕食\n\nもんじゃ焼き。' });
    expect((await connector.get(article.id)).content).toBe('# 東京散策\n\n浅草へ行った。\n\n## 夕食\n\nもんじゃ焼き。\n');
  });

  it('saves another article on the same day, and refuses the same name without changing it', async () => {
    const other = await connector.create({ date, title: `${marker} 夜`, content: '飲み会' });
    created.push(other.external_ref);
    expect(other.id).not.toBe(article.id);

    const before = await readFile(abs(article.external_ref));
    await expect(connector.create({ date, title: `${marker} 東京散策`, content: '上書き' })).rejects.toBeInstanceOf(
      InputValidationError,
    );
    expect(Buffer.compare(await readFile(abs(article.external_ref)), before)).toBe(0);
  });

  it('rejects knowledge ids and reports missing articles as not found', async () => {
    await expect(connector.get(`obsidian:${knowledgeDir ?? 'AI Foundation/Knowledge'}/x.md`)).rejects.toBeInstanceOf(
      InputValidationError,
    );
    await expect(connector.get(`lifelog:${date}-${marker} 存在しない.md`)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('leaves the knowledge directory as it was', async () => {
    expect(await knowledgeFiles()).toEqual(knowledgeBefore);
  });
});
