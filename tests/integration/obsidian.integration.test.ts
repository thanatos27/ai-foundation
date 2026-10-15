import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObsidianKnowledgeConnector } from '../../src/connectors/obsidian/connector.js';
import { FilesystemVaultStorage } from '../../src/connectors/obsidian/filesystem-storage.js';
import type { Knowledge } from '../../src/domain/index.js';
import { NotFoundError } from '../../src/errors.js';
import { enabled, integrationConfig, runLabel } from './setup.js';

/**
 * Runs against the vault in sources.knowledge.obsidian (config.local.yaml). Use a vault (or a
 * knowledge_dir) made for testing: notes are created under knowledge_dir and removed afterwards.
 */
const config = enabled ? await integrationConfig() : undefined;
const obsidian = config?.sources.knowledge.obsidian;
const run = enabled && !!obsidian?.vault_path && !!obsidian.knowledge_dir;

describe.runIf(run)('Obsidian knowledge (real vault)', () => {
  // The describe body runs even when skipped: read the config only when enabled.
  const vaultPath = obsidian?.vault_path ?? '';
  const knowledgeDir = obsidian?.knowledge_dir ?? '';
  const connector = new ObsidianKnowledgeConnector({
    knowledgeDir,
    storage: new FilesystemVaultStorage({ vaultPath, knowledgeDir }),
  });
  const abs = (path: string) => join(vaultPath, ...path.split('/'));
  /** Unique word in every note of this run, so searches see only them. */
  const marker = `afit${Date.now()}`;
  const subdir = `af-it ${marker}`;
  const created: string[] = [];
  let cap: Knowledge;

  beforeAll(async () => {
    await connector.search({}); // fails early on a configuration error
  });

  afterAll(async () => {
    // The connector never deletes: remove what this run created from here.
    await Promise.allSettled(created.map((path) => rm(abs(path), { force: true })));
    await rm(abs(`${knowledgeDir}/${subdir}`), { recursive: true, force: true });
  });

  it('creates a note that Obsidian can read (UTF-8, LF, frontmatter)', async () => {
    cap = await connector.create({
      title: `${runLabel} CAP定理`,
      description: 'CAP定理と分散システムでの考え方',
      content: `CAP定理では一貫性・可用性・分断耐性のうち2つまでしか同時に満たせない。${marker}`,
      area: 'personal',
      tags: ['af-it', 'distributed-systems'],
    });
    created.push(cap.external_ref);
    expect(cap.id).toBe(`obsidian:${cap.external_ref}`);
    expect(cap.external_ref.startsWith(`${knowledgeDir}/`)).toBe(true);
    expect(cap.id).not.toContain(vaultPath);

    const text = await readFile(abs(cap.external_ref), 'utf8');
    expect(text.startsWith('---\ntitle: ')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).toContain('area: personal');
  });

  it('finds the note by body text, tags and area, and gets the full body', async () => {
    const byBody = await connector.search({ query: marker.toUpperCase() });
    expect(byBody.map((item) => item.id)).toEqual([cap.id]);
    expect(byBody[0]).toMatchObject({ description: 'CAP定理と分散システムでの考え方', area: 'personal' });
    expect(byBody[0]?.snippet).toContain(marker);

    const byTags = await connector.search({ tags: ['AF-IT', 'distributed-systems'], area: 'personal' });
    expect(byTags.map((item) => item.id)).toContain(cap.id);

    const doc = await connector.get(cap.id!);
    expect(doc.content).toContain(marker);
  });

  it('searches subfolders recursively', async () => {
    const path = `${knowledgeDir}/${subdir}/深い/手書き.md`;
    await mkdir(join(abs(`${knowledgeDir}/${subdir}`), '深い'), { recursive: true });
    await writeFile(abs(path), `# 手書きのメモ\n\n${marker} recursive\n`, 'utf8');
    const results = await connector.search({ query: `${marker} recursive` });
    expect(results).toMatchObject([{ id: `obsidian:${path}`, title: '手書き', tags: [] }]);
  });

  it('appends to the end of the body without changing the frontmatter', async () => {
    const before = await readFile(abs(cap.external_ref), 'utf8');
    await connector.append({ id: cap.id!, content: 'PACELCについても関連して調べた。' });
    const after = await readFile(abs(cap.external_ref), 'utf8');
    expect(after).toBe(`${before}\nPACELCについても関連して調べた。\n`);
  });

  it('reads external edits, and finds a moved note under its new id', async () => {
    const text = await readFile(abs(cap.external_ref), 'utf8');
    await writeFile(abs(cap.external_ref), text.replace('area: personal', 'area: work'), 'utf8');
    expect((await connector.get(cap.id!)).knowledge.area).toBe('work');

    const moved = `${knowledgeDir}/${subdir}/${cap.external_ref.split('/').at(-1)}`;
    await mkdir(abs(`${knowledgeDir}/${subdir}`), { recursive: true });
    await rename(abs(cap.external_ref), abs(moved));
    created.push(moved);

    await expect(connector.get(cap.id!)).rejects.toBeInstanceOf(NotFoundError);
    const found = await connector.search({ query: marker, tags: ['af-it'] });
    expect(found.map((item) => item.id)).toEqual([`obsidian:${moved}`]);
  });
});
