import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesystemVaultDirectory, type VaultDirectoryLabels } from '../../../src/connectors/obsidian/vault-directory.js';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../../src/errors.js';
import { createTestVault, linkDirectory, type TestVault } from '../../helpers/vault.js';

/** errno to throw from the next readFile / open (permission errors cannot be made portably on Windows). */
const fsFailure = vi.hoisted(() => ({ code: undefined as string | undefined, path: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const failing =
    <F extends (...args: never[]) => Promise<unknown>>(fn: F) =>
    (...args: Parameters<F>) => {
      if (fsFailure.code) {
        const code = fsFailure.code;
        fsFailure.code = undefined;
        // Like a real errno error: the message names the absolute path.
        return Promise.reject(Object.assign(new Error(`${code}: permission denied, open '${fsFailure.path}'`), { code }));
      }
      return fn(...args);
    };
  return { ...actual, readFile: failing(actual.readFile), open: failing(actual.open) };
});

/** A directory with its own labels, to show that every message comes from them. */
const DIR = 'Test/Notes';

const labels: VaultDirectoryLabels = {
  dirConfigKey: 'sources.test.dir',
  dirName: 'test directory',
  quote: (segments) => `"test:${segments.join('/')}"`,
  notFound: (segments, cause) => new NotFoundError(`test ${segments.join('/')} is gone`, { cause }),
  alreadyExists: (segments, cause) => new InputValidationError(`test ${segments.join('/')} is taken`, { cause }),
};

let vault: TestVault;
let directory: FilesystemVaultDirectory;

beforeEach(async () => {
  vault = await createTestVault();
  await mkdir(vault.abs(DIR), { recursive: true });
  directory = new FilesystemVaultDirectory({ vaultPath: vault.vault, dir: DIR, labels });
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

describe('labels', () => {
  it('names the configured directory key and name in configuration errors', async () => {
    const unset = new FilesystemVaultDirectory({ vaultPath: vault.vault, dir: undefined, labels });
    expect((await expectError(unset.check(), ConfigurationError)).message).toContain('sources.test.dir is not set');

    const missing = new FilesystemVaultDirectory({ vaultPath: vault.vault, dir: 'Nope', labels });
    expect((await expectError(missing.check(), ConfigurationError)).message).toContain('the test directory "Nope"');

    const noVault = new FilesystemVaultDirectory({ vaultPath: undefined, dir: DIR, labels });
    expect((await expectError(noVault.check(), ConfigurationError)).message).toContain(
      'sources.knowledge.obsidian.vault_path is not set',
    );
  });

  it('uses notFound, alreadyExists and quote for file errors', async () => {
    expect((await expectError(directory.read(['a.md']), NotFoundError)).message).toContain('test a.md is gone');
    await directory.createExclusive(['a.md'], 'x');
    expect((await expectError(directory.createExclusive(['a.md'], 'y'), InputValidationError)).message).toContain(
      'test a.md is taken',
    );

    await linkDirectory(vault.outside, vault.abs(`${DIR}/linked`));
    expect((await expectError(directory.read(['linked', 'a.md']), InputValidationError)).message).toContain(
      '"test:linked/a.md" goes through a symbolic link or junction',
    );
  });
});

describe('bytes', () => {
  it('reads the stored bytes without decoding (a byte order mark and invalid UTF-8 are kept)', async () => {
    const stored = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('本文'), Buffer.from([0xff, 0xfe])]);
    await writeFile(vault.abs(`${DIR}/raw.md`), stored);
    const { bytes, modifiedAt } = await directory.read(['raw.md']);
    expect(Buffer.compare(bytes, stored)).toBe(0);
    expect(modifiedAt).toBeGreaterThan(0);
  });

  it('writes UTF-8 on create and append, and appends without recreating a deleted file', async () => {
    await directory.createExclusive(['u.md'], 'あ😀\n');
    await directory.append(['u.md'], 'い\n');
    expect(await readFile(vault.abs(`${DIR}/u.md`), 'utf8')).toBe('あ😀\nい\n');

    await writeFile(vault.abs(`${DIR}/gone.md`), 'x');
    await rm(vault.abs(`${DIR}/gone.md`));
    await expectError(directory.append(['gone.md'], 'y'), NotFoundError);
    await expect(readFile(vault.abs(`${DIR}/gone.md`))).rejects.toThrow();
  });
});

describe('list', () => {
  it('lists Markdown files recursively as segments, without following links', async () => {
    await vault.write(`${DIR}/a.md`, 'a');
    await vault.write(`${DIR}/sub/b.md`, 'b');
    await vault.write(`${DIR}/c.txt`, 'c');
    await writeFile(join(vault.outside, 'o.md'), 'o');
    await linkDirectory(vault.outside, vault.abs(`${DIR}/linked`));
    const listed = (await directory.list()).map(({ segments }) => segments.join('/')).sort();
    expect(listed).toEqual(['a.md', 'sub/b.md']);
  });
});

describe('errno', () => {
  it.each(['EACCES', 'EPERM', 'EBUSY'])('reports %s as ProviderApiError with the code only', async (code) => {
    await vault.write(`${DIR}/a.md`, 'a');
    fsFailure.path = vault.abs(`${DIR}/a.md`);

    fsFailure.code = code;
    let error = await expectError(directory.read(['a.md']), ProviderApiError);
    expect(error.message).toBe(`Obsidian API error: cannot read "test:a.md" (${code})`);

    fsFailure.code = code;
    error = await expectError(directory.append(['a.md'], 'x'), ProviderApiError);
    expect(error.message).toBe(`Obsidian API error: cannot write "test:a.md" (${code})`);

    fsFailure.code = code;
    error = await expectError(directory.createExclusive(['b.md'], 'x'), ProviderApiError);
    expect(error.message).toBe(`Obsidian API error: cannot create "test:b.md" (${code})`);
    expect((error.cause as NodeJS.ErrnoException).code).toBe(code);
  });
});
