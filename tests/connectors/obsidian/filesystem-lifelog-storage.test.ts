import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemLifeLogStorage } from '../../../src/connectors/obsidian/filesystem-lifelog-storage.js';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../../src/errors.js';
import {
  canLinkFiles,
  createTestVault,
  LIFELOG_DIR,
  linkDirectory,
  linkFile,
  type TestVault,
} from '../../helpers/vault.js';

const fileLinks = await canLinkFiles();
const windows = process.platform === 'win32';

/** Whether this file system resolves another spelling to the same directory (case, Windows 8.3 short name). */
async function aliasWorks(alias: (vault: TestVault) => string): Promise<boolean> {
  const probe = await createTestVault();
  try {
    return await lstat(probe.abs(alias(probe))).then(
      () => true,
      () => false,
    );
  } finally {
    await probe.cleanup();
  }
}
const SHORT_KNOWLEDGE = 'AI Foundation/KNOWLE~1';
const shortNames = await aliasWorks(() => SHORT_KNOWLEDGE);
const caseInsensitive = await aliasWorks(() => 'ai foundation/knowledge');
const NAME = '2026-10-03-東京散策.md';
const l = (name: string) => `${LIFELOG_DIR}/${name}`;

let vault: TestVault;
let storage: FilesystemLifeLogStorage;

beforeEach(async () => {
  vault = await createTestVault();
  storage = new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory: LIFELOG_DIR });
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

/** Bytes of a file as strict UTF-8: throws when they are not. */
async function strictText(path: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(vault.abs(path)));
}

describe('read / createExclusive / append', () => {
  it('creates, reads and appends to a file directly in the life log directory', async () => {
    await storage.createExclusive(NAME, '# 東京散策\n');
    await storage.append(NAME, '\n夕食\n');
    expect(await storage.read(NAME)).toEqual({ name: NAME, text: '# 東京散策\n\n夕食\n' });
    expect(storage.refOf(NAME)).toBe(`${LIFELOG_DIR}/${NAME}`);
  });

  it('writes valid UTF-8 without a byte order mark (Japanese, emoji, surrogate pairs)', async () => {
    const text = '日本語 😀 𠮷野家 ｶﾀｶﾅ\r\n';
    await storage.createExclusive(NAME, text);
    await storage.append(NAME, '追記 👍\r\n');
    const stored = await strictText(l(NAME));
    expect(stored).toBe(`${text}追記 👍\r\n`);
    expect(stored.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('never overwrites: anything with the same name is an input error and stays as it was', async () => {
    await vault.write(l(NAME), '既存');
    const error = await expectError(storage.createExclusive(NAME, '新規'), InputValidationError);
    expect(error.message).toContain(`"lifelog:${NAME}" already exists`);
    expect(error.message).toContain('lifelog_append');
    expect(await vault.read(l(NAME))).toBe('既存');

    await mkdir(vault.abs(l('2026-10-04-dir.md')));
    await expectError(storage.createExclusive('2026-10-04-dir.md', 'x'), InputValidationError);
  });

  it('reports a missing file as not found, without the vault path', async () => {
    const error = await expectError(storage.read(NAME), NotFoundError);
    expect(error.message).toContain(`"lifelog:${NAME}" was not found`);
    await expectError(storage.append(NAME, 'x'), NotFoundError);
    expect(await readdir(vault.abs(LIFELOG_DIR))).toEqual([]); // append never creates
  });

  it('treats a directory with an article name as not found', async () => {
    await mkdir(vault.abs(l(NAME)));
    await expectError(storage.read(NAME), NotFoundError);
    await expectError(storage.append(NAME, 'x'), NotFoundError);
  });
});

describe('decoding', () => {
  it('drops a byte order mark', async () => {
    await writeFile(vault.abs(l(NAME)), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('本文\n')]));
    expect((await storage.read(NAME)).text).toBe('本文\n');
  });

  it('rejects a file that is not valid UTF-8 (Shift_JIS, broken bytes) instead of replacing characters', async () => {
    await writeFile(vault.abs(l(NAME)), Buffer.from([0x93, 0x8c, 0x8b, 0x9e])); // "東京" in Shift_JIS
    const error = await expectError(storage.read(NAME), ProviderApiError);
    expect(error.message).toContain(`"lifelog:${NAME}" is not valid UTF-8`);

    await writeFile(vault.abs(l(NAME)), Buffer.concat([Buffer.from('途中まで'), Buffer.from([0xe6, 0x9d])]));
    await expectError(storage.read(NAME), ProviderApiError);
  });
});

describe('configuration', () => {
  it.each([
    ['the directory is not set', { directory: undefined }, /sources\.lifelog\.obsidian\.directory is not set/],
    ['the vault path is not set', { vaultPath: undefined }, /sources\.knowledge\.obsidian\.vault_path is not set/],
    ['the directory does not exist', { directory: 'AI Foundation/Missing' }, /life log directory "AI Foundation\/Missing"/],
  ])('is a configuration error when %s, and creates nothing', async (_label, options, message) => {
    const configured = new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory: LIFELOG_DIR, ...options });
    const actions = [() => configured.read(NAME), () => configured.createExclusive(NAME, 'x'), () => configured.append(NAME, 'x')];
    for (const action of actions) {
      expect((await expectError(action(), ConfigurationError)).message).toMatch(message);
    }
    expect(await readdir(vault.abs('AI Foundation'))).toEqual(['Knowledge', 'LifeLog']);
    expect(await readdir(vault.abs(LIFELOG_DIR))).toEqual([]);
  });

  it('rejects a life log directory reached through a junction', async () => {
    await mkdir(join(vault.outside, 'LifeLog'), { recursive: true });
    await linkDirectory(join(vault.outside, 'LifeLog'), vault.abs('Linked'));
    const linked = new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory: 'Linked' });
    const error = await expectError(linked.createExclusive(NAME, 'x'), ConfigurationError);
    expect(error.message).toMatch(/symbolic link or junction/);
    expect(await readdir(join(vault.outside, 'LifeLog'))).toEqual([]);
  });
});

describe('boundary', () => {
  it('does not follow a junction with an article name to a directory outside the vault', async () => {
    await writeFile(join(vault.outside, 'secret.md'), '外');
    await linkDirectory(vault.outside, vault.abs(l(NAME)));
    expect((await expectError(storage.read(NAME), InputValidationError)).message).toMatch(/symbolic link or junction/);
    await expectError(storage.append(NAME, 'x'), InputValidationError);
    expect(await readFile(join(vault.outside, 'secret.md'), 'utf8')).toBe('外');
  });

  it.skipIf(!fileLinks)('does not follow a file symlink to a file outside the vault', async () => {
    await writeFile(join(vault.outside, 'secret.md'), '外');
    await linkFile(join(vault.outside, 'secret.md'), vault.abs(l(NAME)));
    expect((await expectError(storage.read(NAME), InputValidationError)).message).toMatch(/symbolic link or junction/);
    await expectError(storage.append(NAME, 'x'), InputValidationError);
    await expectError(storage.createExclusive(NAME, 'x'), InputValidationError);
    expect(await readFile(join(vault.outside, 'secret.md'), 'utf8')).toBe('外');
  });
});

describe('apart from the knowledge directory (by real path)', () => {
  const KNOWLEDGE_DIR = 'AI Foundation/Knowledge';
  const aliased = (directory: string) =>
    new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory, knowledgeDir: KNOWLEDGE_DIR });

  /** Every action is refused and nothing is written into the knowledge directory. */
  async function expectRefused(storage: FilesystemLifeLogStorage): Promise<void> {
    await vault.write(`${KNOWLEDGE_DIR}/${NAME}`, 'knowledge');
    const before = (await readdir(vault.abs(KNOWLEDGE_DIR), { recursive: true })).sort();
    const actions = [() => storage.createExclusive('2026-10-24-x.md', 'x'), () => storage.read(NAME), () => storage.append(NAME, 'x')];
    for (const action of actions) {
      const error = await expectError(action(), ConfigurationError);
      expect(error.message).toContain('the knowledge directory "AI Foundation/Knowledge"');
    }
    expect((await readdir(vault.abs(KNOWLEDGE_DIR), { recursive: true })).sort()).toEqual(before);
    expect(await vault.read(`${KNOWLEDGE_DIR}/${NAME}`)).toBe('knowledge');
  }

  it.skipIf(!shortNames)('refuses a Windows 8.3 short name of the knowledge directory', async () => {
    await expectRefused(aliased(SHORT_KNOWLEDGE));
  });

  it.skipIf(!shortNames)('refuses a directory inside the knowledge directory reached by its short name', async () => {
    await mkdir(vault.abs(`${KNOWLEDGE_DIR}/LifeLog`));
    await expectRefused(aliased(`${SHORT_KNOWLEDGE}/LifeLog`));
  });

  it.skipIf(!caseInsensitive)('refuses another case of the knowledge directory', async () => {
    await expectRefused(aliased('ai foundation/knowledge'));
  });

  it('refuses a directory that contains the knowledge directory', async () => {
    await expectRefused(aliased('AI Foundation'));
  });

  it('works next to the knowledge directory, and while the knowledge directory is unset or missing', async () => {
    await aliased(LIFELOG_DIR).createExclusive(NAME, 'a');
    await new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory: LIFELOG_DIR, knowledgeDir: undefined }).read(NAME);
    await new FilesystemLifeLogStorage({ vaultPath: vault.vault, directory: LIFELOG_DIR, knowledgeDir: 'Missing' }).read(NAME);
  });
});

describe.skipIf(!windows)('alternate data streams (Windows)', () => {
  it('refuses a name with ":" instead of reading or writing a stream of another file', async () => {
    await vault.write(l('2026-10-24-private.txt'), 'plain');
    await writeFile(vault.abs(l('2026-10-24-private.txt:notes.md')), 'stream');
    const stream = '2026-10-24-private.txt:notes.md';
    expect((await expectError(storage.read(stream), InputValidationError)).message).toContain('alternate data stream');
    await expectError(storage.append(stream, 'x'), InputValidationError);
    await expectError(storage.createExclusive('2026-10-24-new.txt:notes.md', 'x'), InputValidationError);
    expect(await readFile(vault.abs(l(stream)), 'utf8')).toBe('stream');
    expect(await readdir(vault.abs(LIFELOG_DIR))).toEqual(['2026-10-24-private.txt']);
  });
});
