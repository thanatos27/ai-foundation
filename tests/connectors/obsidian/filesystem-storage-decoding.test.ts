import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObsidianKnowledgeConnector } from '../../../src/connectors/obsidian/connector.js';
import { FilesystemVaultStorage } from '../../../src/connectors/obsidian/filesystem-storage.js';
import type { VaultPath } from '../../../src/connectors/obsidian/id.js';
import { createTestVault, KNOWLEDGE_DIR, type TestVault } from '../../helpers/vault.js';

/**
 * Knowledge reads text leniently, as it did before the file system code was shared with life logs:
 * a byte order mark is dropped and bytes that are not UTF-8 become U+FFFD instead of an error.
 */
const p = (rest: string) => `${KNOWLEDGE_DIR}/${rest}` as VaultPath;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const INVALID = Buffer.from([0xff, 0xfe, 0x80]);

let vault: TestVault;
let storage: FilesystemVaultStorage;

beforeEach(async () => {
  vault = await createTestVault();
  storage = new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: KNOWLEDGE_DIR });
});

afterEach(async () => {
  await vault.cleanup();
});

describe('knowledge text decoding', () => {
  it('drops a byte order mark', async () => {
    await writeFile(vault.abs(p('bom.md')), Buffer.concat([BOM, Buffer.from('---\ntitle: BOM\n---\n本文\n')]));
    expect((await storage.read(p('bom.md'))).text).toBe('---\ntitle: BOM\n---\n本文\n');
  });

  it('reads invalid UTF-8 as U+FFFD without an error, the same as readFile(…, "utf8")', async () => {
    const bytes = Buffer.concat([Buffer.from('前'), INVALID, Buffer.from('後\n')]);
    await writeFile(vault.abs(p('broken.md')), bytes);
    const { text } = await storage.read(p('broken.md'));
    expect(text).toBe(await readFile(vault.abs(p('broken.md')), 'utf8'));
    expect(text.startsWith('前�')).toBe(true);
    expect(text.endsWith('後\n')).toBe(true);
  });

  it('still finds and appends to a note with invalid UTF-8, leaving its bytes as they were', async () => {
    const original = Buffer.concat([Buffer.from('# 壊れたメモ\n\nmarker '), INVALID, Buffer.from('\n')]);
    await writeFile(vault.abs(p('broken.md')), original);
    const connector = new ObsidianKnowledgeConnector({ knowledgeDir: KNOWLEDGE_DIR, storage, warn: () => undefined });

    const results = await connector.search({ query: 'marker' });
    expect(results.map((item) => item.title)).toEqual(['broken']);

    await connector.append({ id: results[0]!.id!, content: '追記' });
    const after = await readFile(vault.abs(p('broken.md')));
    expect(Buffer.compare(after.subarray(0, original.length), original)).toBe(0);
    expect(after.subarray(original.length).toString('utf8')).toBe('\n追記\n');
  });
});
