import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemVaultStorage } from '../../../src/connectors/obsidian/filesystem-storage.js';
import type { VaultPath } from '../../../src/connectors/obsidian/id.js';
import { ConfigurationError, InputValidationError, NotFoundError } from '../../../src/errors.js';
import { canLinkFiles, createTestVault, KNOWLEDGE_DIR, linkDirectory, linkFile, type TestVault } from '../../helpers/vault.js';

const fileLinks = await canLinkFiles();
const p = (rest: string) => `${KNOWLEDGE_DIR}/${rest}` as VaultPath;

let vault: TestVault;
let storage: FilesystemVaultStorage;

beforeEach(async () => {
  vault = await createTestVault();
  storage = new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: KNOWLEDGE_DIR });
});

afterEach(async () => {
  await vault.cleanup();
});

/** Runs `action`, expects it to throw `type`, and checks the message leaks no absolute path. */
async function expectError(action: Promise<unknown>, type: new (...args: never[]) => Error): Promise<Error> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error).toBeInstanceOf(type);
  for (const secret of vault.secrets) expect(error!.message).not.toContain(secret);
  return error!;
}

describe('checkKnowledgeDir', () => {
  it('passes for an existing knowledge directory', async () => {
    await expect(storage.checkKnowledgeDir()).resolves.toBeUndefined();
  });

  it.each([
    ['vault_path is not set', { vaultPath: undefined, knowledgeDir: KNOWLEDGE_DIR }, /vault_path is not set/],
    ['knowledge_dir is not set', { vaultPath: 'VAULT', knowledgeDir: undefined }, /knowledge_dir is not set/],
    ['the vault does not exist', { vaultPath: 'MISSING', knowledgeDir: KNOWLEDGE_DIR }, /vault .* does not exist/],
    ['the knowledge directory does not exist', { vaultPath: 'VAULT', knowledgeDir: 'Nope/Knowledge' }, /"Nope\/Knowledge" does not exist/],
  ])('reports a configuration error when %s', async (_label, options, message) => {
    const resolved = {
      ...options,
      vaultPath:
        options.vaultPath === 'VAULT' ? vault.vault : options.vaultPath === 'MISSING' ? join(vault.base, 'missing') : undefined,
    };
    const error = await expectError(new FilesystemVaultStorage(resolved).checkKnowledgeDir(), ConfigurationError);
    expect(error.message).toMatch(message);
  });

  it('reports a configuration error when the vault or knowledge directory is a file', async () => {
    await writeFile(join(vault.base, 'file-vault'), '');
    await expectError(
      new FilesystemVaultStorage({ vaultPath: join(vault.base, 'file-vault'), knowledgeDir: KNOWLEDGE_DIR }).checkKnowledgeDir(),
      ConfigurationError,
    );
    await vault.write('Plain', '');
    await expectError(
      new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: 'Plain' }).checkKnowledgeDir(),
      ConfigurationError,
    );
  });
});

describe('knowledge_dir boundary (links between the vault root and knowledge_dir)', () => {
  it('rejects a knowledge directory that is itself a link out of the vault', async () => {
    await linkDirectory(vault.outside, vault.abs('Linked'));
    const linked = new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: 'Linked' });
    await writeFile(join(vault.outside, 'secret.md'), 'secret');

    for (const action of [
      () => linked.checkKnowledgeDir(),
      () => linked.list(),
      () => linked.read('Linked/secret.md' as VaultPath),
      () => linked.createExclusive('Linked/new.md' as VaultPath, 'x'),
      () => linked.append('Linked/secret.md' as VaultPath, 'x'),
    ]) {
      const error = await expectError(action(), ConfigurationError);
      expect(error.message).toMatch(/symbolic link or junction/);
    }
    expect(await readdir(vault.outside)).toEqual(['secret.md']);
    expect(await vault.read('Linked/secret.md')).toBe('secret');
  });

  it('rejects a link in an intermediate segment of knowledge_dir', async () => {
    await linkDirectory(vault.outside, vault.abs('Via'));
    await vault.write('../outside/Knowledge/a.md', 'outside');
    const via = new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: 'Via/Knowledge' });

    for (const action of [
      () => via.list(),
      () => via.createExclusive('Via/Knowledge/new.md' as VaultPath, 'x'),
      () => via.append('Via/Knowledge/a.md' as VaultPath, 'x'),
    ]) {
      await expectError(action(), ConfigurationError);
    }
    expect(await readdir(join(vault.outside, 'Knowledge'))).toEqual(['a.md']);
  });

  it('allows the vault root itself to be a link', async () => {
    const linkedVault = join(vault.base, 'vault-link');
    await linkDirectory(vault.vault, linkedVault);
    const viaLink = new FilesystemVaultStorage({ vaultPath: linkedVault, knowledgeDir: KNOWLEDGE_DIR });
    await viaLink.createExclusive(p('a.md'), 'hello\n');
    expect(await vault.read(`${KNOWLEDGE_DIR}/a.md`)).toBe('hello\n');
    expect((await viaLink.list()).map((file) => file.path)).toEqual([p('a.md')]);
  });
});

describe('list', () => {
  it('returns regular .md files at any depth, including dot-prefixed entries', async () => {
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/');
    for (const rest of ['CAP定理.md', 'AI/RAG.md', '.archive/old.md', '.hidden.md', `${deep}/deep.md`]) {
      await vault.write(p(rest), 'x');
    }
    for (const rest of ['notes.txt', 'UPPER.MD', 'no-extension', 'AI/image.png']) await vault.write(p(rest), 'x');
    await vault.write('Outside Knowledge.md', 'x');

    const paths = (await storage.list()).map((file) => file.path).sort();
    expect(paths).toEqual(
      ['.archive/old.md', '.hidden.md', 'AI/RAG.md', 'CAP定理.md', `${deep}/deep.md`].map(p).sort(),
    );
  });

  it('reports modification times', async () => {
    await vault.write(p('a.md'), 'x');
    const [file] = await storage.list();
    expect(file?.modifiedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it('does not follow directory links inside the knowledge directory', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkDirectory(vault.outside, vault.abs(p('linked')));
    await vault.write(p('real.md'), 'x');
    expect((await storage.list()).map((file) => file.path)).toEqual([p('real.md')]);
  });

  it.skipIf(!fileLinks)('does not return file links', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkFile(join(vault.outside, 'secret.md'), vault.abs(p('link.md')));
    expect(await storage.list()).toEqual([]);
  });
});

describe('names starting with ".."', () => {
  it('treats ..note.md and ..archive as names inside the knowledge directory', async () => {
    await vault.write(p('..note.md'), 'a');
    await vault.write(p('..archive/note.md'), 'b');
    expect((await storage.list()).map((file) => file.path).sort()).toEqual([p('..archive/note.md'), p('..note.md')].sort());
    expect((await storage.read(p('..note.md'))).text).toBe('a');
    expect((await storage.read(p('..archive/note.md'))).text).toBe('b');
    await storage.append(p('..archive/note.md'), 'c');
    expect(await vault.read(p('..archive/note.md'))).toBe('bc');
  });
});

describe('read', () => {
  it('reads UTF-8 text without a byte order mark', async () => {
    await vault.write(p('AI/RAG.md'), '﻿---\ntitle: RAG\n---\n本文\n');
    expect(await storage.read(p('AI/RAG.md'))).toMatchObject({ path: p('AI/RAG.md'), text: '---\ntitle: RAG\n---\n本文\n' });
  });

  it.each([
    ['a missing file', 'missing.md'],
    ['a file in a missing directory', 'nope/missing.md'],
  ])('reports %s as not found', async (_label, rest) => {
    const error = await expectError(storage.read(p(rest)), NotFoundError);
    expect(error.message).toContain(`"obsidian:${p(rest)}"`);
  });

  it('reports a directory as not found', async () => {
    await vault.write(p('dir.md/inner.md'), 'x');
    await expectError(storage.read(p('dir.md')), NotFoundError);
  });

  it('reports a path through a file as not found', async () => {
    await vault.write(p('file'), 'x');
    await expectError(storage.read(p('file/a.md')), NotFoundError);
  });

  it('rejects a path through a directory link out of the knowledge directory', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkDirectory(vault.outside, vault.abs(p('linked')));
    const error = await expectError(storage.read(p('linked/secret.md')), InputValidationError);
    expect(error.message).toMatch(/symbolic link or junction/);
  });

  it.skipIf(!fileLinks)('rejects a file link out of the knowledge directory', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkFile(join(vault.outside, 'secret.md'), vault.abs(p('link.md')));
    await expectError(storage.read(p('link.md')), InputValidationError);
  });
});

describe('createExclusive', () => {
  it('creates a new file with the text as UTF-8', async () => {
    await storage.createExclusive(p('CAP定理.md'), '---\ntitle: CAP定理\n---\n\n本文\n');
    expect(await vault.read(p('CAP定理.md'))).toBe('---\ntitle: CAP定理\n---\n\n本文\n');
  });

  it('never overwrites an existing file', async () => {
    await vault.write(p('a.md'), 'original');
    const error = await expectError(storage.createExclusive(p('a.md'), 'new'), InputValidationError);
    expect(error.message).toMatch(/already exists.*knowledge_append/);
    expect(await vault.read(p('a.md'))).toBe('original');
  });

  it('fails when a directory has the name', async () => {
    await vault.write(p('a.md/inner.md'), 'x');
    await expectError(storage.createExclusive(p('a.md'), 'new'), InputValidationError);
  });

  it('does not write through an existing directory link', async () => {
    await linkDirectory(vault.outside, vault.abs(p('linked.md')));
    await expectError(storage.createExclusive(p('linked.md'), 'new'), InputValidationError);
    expect(await readdir(vault.outside)).toEqual([]);
  });

  it.skipIf(!fileLinks)('does not write through an existing file link', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkFile(join(vault.outside, 'secret.md'), vault.abs(p('link.md')));
    await expectError(storage.createExclusive(p('link.md'), 'new'), InputValidationError);
    expect(await vault.read('../outside/secret.md')).toBe('secret');
  });
});

describe('append', () => {
  it('adds text to the end and leaves the rest byte for byte', async () => {
    const original = '---\ntitle: a\nunknown: keep\n---\n\nbody\n';
    await vault.write(p('a.md'), original);
    await storage.append(p('a.md'), '\nmore\n');
    expect(await vault.read(p('a.md'))).toBe(`${original}\nmore\n`);
  });

  it('does not create a missing file', async () => {
    await expectError(storage.append(p('missing.md'), 'x'), NotFoundError);
    expect(await readdir(vault.abs(KNOWLEDGE_DIR))).toEqual([]);
  });

  it('rejects a path through a directory link and leaves the target unchanged', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkDirectory(vault.outside, vault.abs(p('linked')));
    await expectError(storage.append(p('linked/secret.md'), 'x'), InputValidationError);
    expect(await vault.read('../outside/secret.md')).toBe('secret');
  });

  it.skipIf(!fileLinks)('rejects a file link and leaves the target unchanged', async () => {
    await writeFile(join(vault.outside, 'secret.md'), 'secret');
    await linkFile(join(vault.outside, 'secret.md'), vault.abs(p('link.md')));
    await expectError(storage.append(p('link.md'), 'x'), InputValidationError);
    expect(await vault.read('../outside/secret.md')).toBe('secret');
  });
});

describe('apart from the life log directory (by real path)', () => {
  it('refuses a knowledge_dir that is the life log directory under another spelling', async () => {
    // knowledge_dir "AI Foundation/Knowledge", life log dir given as its 8.3 short name or another case.
    const aliases = [];
    for (const alias of ['AI Foundation/KNOWLE~1', 'ai foundation/knowledge']) {
      if (await lstat(vault.abs(alias)).then(() => true, () => false)) aliases.push(alias);
    }
    for (const lifeLogDir of [...aliases, 'AI Foundation/Knowledge/LifeLog', 'AI Foundation']) {
      await vault.write(`${KNOWLEDGE_DIR}/LifeLog/x.md`, 'x');
      const storage = new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: KNOWLEDGE_DIR, lifeLogDir });
      const error = await expectError(storage.list(), ConfigurationError);
      expect(error.message).toContain('life log directory');
      await expectError(storage.createExclusive(p('new.md'), 'x'), ConfigurationError);
    }
  });

  it('works next to the life log directory, and while it is unset', async () => {
    await vault.write(p('a.md'), 'a');
    for (const lifeLogDir of ['AI Foundation/LifeLog', undefined]) {
      const storage = new FilesystemVaultStorage({ vaultPath: vault.vault, knowledgeDir: KNOWLEDGE_DIR, lifeLogDir });
      expect((await storage.list()).map(({ path }) => path)).toEqual([p('a.md')]);
    }
  });
});

describe.skipIf(process.platform !== 'win32')('alternate data streams (Windows)', () => {
  it('refuses a path with ":" instead of reading or writing a stream of another file', async () => {
    await vault.write(p('private.txt'), 'plain');
    await writeFile(vault.abs(p('private.txt:notes.md')), 'stream');
    const error = await expectError(storage.read(p('private.txt:notes.md')), InputValidationError);
    expect(error.message).toContain('alternate data stream');
    await expectError(storage.append(p('private.txt:notes.md'), 'x'), InputValidationError);
    await expectError(storage.createExclusive(p('new.txt:notes.md'), 'x'), InputValidationError);
    expect(await readFile(vault.abs(p('private.txt:notes.md')), 'utf8')).toBe('stream');
  });
});
