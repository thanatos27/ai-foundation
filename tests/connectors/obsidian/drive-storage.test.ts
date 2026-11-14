import { beforeEach, describe, expect, it } from 'vitest';
import { DRIVE_FOLDER_MIME } from '../../../src/connectors/google-drive/client.js';
import { DriveCreateLock } from '../../../src/connectors/obsidian/drive-create-lock.js';
import { DriveLifeLogStorage } from '../../../src/connectors/obsidian/drive-lifelog-storage.js';
import { DriveVaultStorage } from '../../../src/connectors/obsidian/drive-storage.js';
import type { VaultPath } from '../../../src/connectors/obsidian/id.js';
import {
  ConfigurationError,
  ConflictError,
  CredentialError,
  InputValidationError,
  MissingCredentialError,
  NotFoundError,
  ProviderApiError,
} from '../../../src/errors.js';
import { FakeDrive, googleError } from '../google-drive/fake-drive.js';

const K = 'AI Foundation/Knowledge';
const L = 'AI Foundation/LifeLog';
const p = (rest: string) => `${K}/${rest}` as VaultPath;
const DOC_MIME = 'application/vnd.google-apps.document';

let drive: FakeDrive;
let lock: DriveCreateLock;
let storage: DriveVaultStorage;
let lifelog: DriveLifeLogStorage;

function knowledgeStorage(options: Partial<ConstructorParameters<typeof DriveVaultStorage>[0]> = {}) {
  return new DriveVaultStorage({
    api: async () => drive,
    vaultFolderId: drive.root,
    knowledgeDir: K,
    lifeLogDir: L,
    createLock: lock,
    ...options,
  });
}

beforeEach(() => {
  drive = new FakeDrive();
  drive.mkdirs(K);
  drive.mkdirs(L);
  lock = new DriveCreateLock();
  storage = knowledgeStorage();
  lifelog = new DriveLifeLogStorage({
    api: async () => drive,
    vaultFolderId: drive.root,
    directory: L,
    knowledgeDir: K,
    createLock: lock,
  });
});

/** Runs `action`, expects it to throw `type`, and checks the message carries no Drive ID. */
async function expectError(action: Promise<unknown>, type: new (...args: never[]) => Error): Promise<Error> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error).toBeInstanceOf(type);
  expect(error!.message).not.toMatch(/id-\d{4}|rev-\d|etag-\d/);
  return error!;
}

const unchanged = (path: string, text: string) => expect(drive.text(drive.idAt(path))).toBe(text);

describe('the vault folder and the knowledge directory', () => {
  it('passes for an existing knowledge directory', async () => {
    await expect(storage.checkKnowledgeDir()).resolves.toBeUndefined();
  });

  it('needs vault_folder_id and knowledge_dir', async () => {
    const noVault = await expectError(knowledgeStorage({ vaultFolderId: undefined }).list(), ConfigurationError);
    expect(noVault.message).toContain('sources.knowledge.obsidian.vault_folder_id is not set');
    const noDir = await expectError(knowledgeStorage({ knowledgeDir: undefined }).list(), ConfigurationError);
    expect(noDir.message).toContain('sources.knowledge.obsidian.knowledge_dir is not set');
  });

  it('reports a vault folder that is missing, not a folder, a shortcut or in the trash', async () => {
    const file = drive.write('a file.md', 'x');
    const shortcut = drive.shortcut(drive.root, 'link');
    const trashed = drive.mkdirs('Old vault');
    drive.trashItem(trashed);
    for (const [vaultFolderId, reason] of [
      ['missing-folder-0000', 'does not exist in Google Drive or cannot be read'],
      [file, 'is not a folder'],
      [shortcut, 'shortcut'],
      [trashed, 'is in the trash'],
    ] as const) {
      const error = await expectError(knowledgeStorage({ vaultFolderId }).list(), ConfigurationError);
      expect(error.message).toContain('sources.knowledge.obsidian.vault_folder_id');
      expect(error.message).toContain(reason);
      expect(error.message).not.toContain(vaultFolderId);
    }
  });

  it('never creates a missing knowledge directory', async () => {
    const before = drive.count;
    const error = await expectError(knowledgeStorage({ knowledgeDir: 'AI Foundation/Missing' }).createExclusive(
      'AI Foundation/Missing/a.md' as VaultPath,
      'x',
    ), ConfigurationError);
    expect(error.message).toContain('"AI Foundation/Missing" does not exist in the vault');
    expect(drive.count).toBe(before);
  });

  it('rejects a knowledge directory reached through a shortcut, a file or a duplicated folder name', async () => {
    drive.shortcut(drive.mkdirs('Via'), 'Knowledge');
    drive.write('File/x', 'x');
    drive.add(drive.mkdirs('Dup'), 'Knowledge', DRIVE_FOLDER_MIME);
    drive.add(drive.idAt('Dup'), 'Knowledge', DRIVE_FOLDER_MIME);
    for (const [knowledgeDir, reason] of [
      ['Via/Knowledge', 'shortcut'],
      ['File/x', 'does not exist in the vault'],
      ['Dup/Knowledge', 'names several items'],
    ] as const) {
      await expectError(knowledgeStorage({ knowledgeDir, lifeLogDir: undefined }).list(), ConfigurationError).then((e) =>
        expect(e.message).toContain(reason),
      );
    }
  });

  it('rejects a knowledge directory that is, is inside or contains the life log folder (by folder ID)', async () => {
    drive.mkdirs(`${K}/Diary`);
    for (const lifeLogDir of [K, `${K}/Diary`, 'AI Foundation']) {
      const error = await expectError(knowledgeStorage({ lifeLogDir }).list(), ConfigurationError);
      expect(error.message).toContain('use separate folders');
    }
    // A life log folder that does not exist yet is the life log tools' problem.
    await expect(knowledgeStorage({ lifeLogDir: 'Elsewhere/LifeLog' }).list()).resolves.toEqual([]);
  });

  it('passes credential errors on', async () => {
    const failing = knowledgeStorage({
      api: async () => {
        throw new MissingCredentialError('Google credential is not configured: set GOOGLE_OAUTH_REFRESH_TOKEN');
      },
    });
    await expectError(failing.list(), MissingCredentialError);
    drive.before = (method) => {
      if (method === 'getItem') throw googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
    };
    await expectError(storage.list(), CredentialError);
  });
});

describe('list (knowledge_search)', () => {
  it('returns Markdown files at any depth with their modification times', async () => {
    drive.write(`${K}/a.md`, 'a');
    drive.write(`${K}/sub/deeper/b.md`, 'b');
    drive.write(`${K}/.hidden/c.md`, 'c');
    const entries = await storage.list();
    expect(entries.map((e) => e.path).sort()).toEqual([p('.hidden/c.md'), p('a.md'), p('sub/deeper/b.md')]);
    expect(entries.every((e) => Number.isFinite(e.modifiedAt) && e.modifiedAt > 0)).toBe(true);
  });

  it('leaves out shortcuts, Google Docs, trashed items, other files and names no ID can hold', async () => {
    const dir = drive.idAt(K);
    drive.shortcut(dir, 'link.md');
    drive.add(dir, 'doc.md', DOC_MIME);
    drive.trashItem(drive.write(`${K}/trashed.md`, 'x'));
    drive.write(`${K}/image.png`, 'x');
    drive.write(`${K}/A.MD`, 'x');
    drive.add(dir, 'a/b.md', 'text/plain', 'x');
    drive.shortcut(dir, 'linked folder');
    drive.write(`${K}/kept.md`, 'x');
    expect((await storage.list()).map((e) => e.path)).toEqual([p('kept.md')]);
  });

  it('reads each listed file by the ID the listing found, without resolving its path again', async () => {
    drive.write(`${K}/a.md`, 'a');
    drive.write(`${K}/sub/b.md`, 'b');
    const entries = await storage.list();
    const lists = drive.callsOf('listChildren').length;
    const files = await Promise.all(entries.map((e) => e.read!()));
    expect(files.map((f) => f.text).sort()).toEqual(['a', 'b']);
    expect(drive.callsOf('listChildren').length).toBe(lists);
    expect(drive.callsOf('download')).toHaveLength(2);
  });

  it('fails the whole listing on names several items share, naming them', async () => {
    const dir = drive.idAt(K);
    drive.add(dir, 'dup.md', 'text/plain', '1');
    drive.add(dir, 'dup.md', 'text/markdown', '2');
    drive.add(drive.mkdirs(`${K}/sub`), 'x.md', 'text/plain', 'x');
    drive.add(dir, 'sub', DRIVE_FOLDER_MIME);
    drive.write(`${K}/fine.md`, 'ok');
    const error = await expectError(storage.list(), ConflictError);
    expect(error.message).toContain('2 path(s) that name several items in Google Drive');
    expect(error.message).toContain(`"obsidian:${K}/dup.md"`);
    expect(error.message).toContain(`"obsidian:${K}/sub"`);
    expect(error.message).toContain('rename or remove the duplicates');
  });

  it('ignores duplicates of files that are not knowledge', async () => {
    drive.write(`${K}/image.png`, '1');
    drive.write(`${K}/image.png`, '2');
    drive.write(`${K}/a.md`, 'a');
    expect((await storage.list()).map((e) => e.path)).toEqual([p('a.md')]);
  });

  it('names at most 10 ambiguous paths', async () => {
    const dir = drive.idAt(K);
    for (let i = 0; i < 12; i += 1) {
      drive.add(dir, `n${i}.md`, 'text/plain', 'x');
      drive.add(dir, `n${i}.md`, 'text/plain', 'y');
    }
    const error = await expectError(storage.list(), ConflictError);
    expect(error.message).toContain('12 path(s)');
    expect(error.message).toContain('and 2 more');
  });
});

describe('read', () => {
  it('reads the exact name only (Drive name queries ignore case)', async () => {
    drive.write(`${K}/Note.md`, 'body');
    expect((await storage.read(p('Note.md'))).text).toBe('body');
    await expectError(storage.read(p('note.md')), NotFoundError);
  });

  it('treats folders, Google Docs and trashed files as not found', async () => {
    drive.mkdirs(`${K}/folder.md`);
    drive.add(drive.idAt(K), 'doc.md', DOC_MIME);
    drive.trashItem(drive.write(`${K}/old.md`, 'x'));
    for (const name of ['folder.md', 'doc.md', 'old.md', 'missing.md', 'missing/x.md']) {
      await expectError(storage.read(p(name)), NotFoundError);
    }
  });

  it('rejects shortcuts at the file and on the way', async () => {
    drive.shortcut(drive.idAt(K), 'link.md');
    drive.shortcut(drive.idAt(K), 'linked');
    await expectError(storage.read(p('link.md')), InputValidationError).then((e) => expect(e.message).toContain('shortcut'));
    await expectError(storage.read(p('linked/a.md')), InputValidationError);
  });

  it('never picks one of several items with the name', async () => {
    drive.add(drive.idAt(K), 'dup.md', 'text/plain', '1');
    drive.add(drive.idAt(K), 'dup.md', 'text/plain', '2');
    drive.add(drive.idAt(K), 'sub', DRIVE_FOLDER_MIME);
    drive.add(drive.idAt(`${K}`), 'sub', DRIVE_FOLDER_MIME);
    await expectError(storage.read(p('dup.md')), ConflictError).then((e) => expect(e.message).toContain('so none is used'));
    await expectError(storage.read(p('sub/a.md')), ConflictError);
  });

  it('reports a file deleted while it is read as not found (also when read by the ID a listing found)', async () => {
    drive.write(`${K}/a.md`, 'x');
    const [entry] = await storage.list();
    drive.before = (method) => {
      if (method === 'download') throw googleError(404, 'notFound');
    };
    await expectError(entry!.read!(), NotFoundError);
    await expectError(storage.read(p('a.md')), NotFoundError);
  });
});

describe('append', () => {
  it('keeps the stored bytes as they were (BOM, CRLF, invalid UTF-8) and adds the UTF-8 text', async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('本文\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\r\n')]);
    const id = drive.write(`${K}/a.md`, original, 'text/plain');
    const read = await storage.append(p('a.md'), (file) => {
      expect(file.text).toBe('本文\r\n��\r\n');
      return '追記\r\n';
    });
    expect(read.text).toBe('本文\r\n��\r\n');
    expect(drive.bytes(id)).toEqual(Buffer.concat([original, Buffer.from('追記\r\n')]));
    expect(drive.mimeTypeOf(id)).toBe('text/plain');
  });

  it('writes nothing when compose throws', async () => {
    drive.write(`${K}/a.md`, 'body');
    await expect(
      storage.append(p('a.md'), () => {
        throw new ProviderApiError('Obsidian', 'malformed');
      }),
    ).rejects.toThrow('malformed');
    expect(drive.callsOf('updateContent')).toHaveLength(0);
    unchanged(`${K}/a.md`, 'body');
  });

  it('refuses to write when the file changed after it was read, keeping that change', async () => {
    const id = drive.write(`${K}/a.md`, 'body\n');
    const error = await expectError(
      storage.append(p('a.md'), () => {
        drive.externalUpdate(id, 'body\nedited in Obsidian\n');
        return 'from AI\n';
      }),
      ConflictError,
    );
    expect(error.message).toContain('changed in Google Drive after it was read, so nothing was appended');
    expect(drive.text(id)).toBe('body\nedited in Obsidian\n');
  });

  it('reads the content of the revision the etag belongs to, even when the file changes in between', async () => {
    const id = drive.write(`${K}/a.md`, 'v1\n');
    drive.before = (method) => {
      if (method === 'downloadRevision') drive.externalUpdate(id, 'v2\n');
    };
    let seen = '';
    await expectError(
      storage.append(p('a.md'), (file) => {
        seen = file.text;
        return 'x\n';
      }),
      ConflictError,
    );
    expect(seen).toBe('v1\n');
    expect(drive.text(id)).toBe('v2\n');
  });

  it('says the result is unknown when the write gets no answer, without trying again', async () => {
    drive.write(`${K}/a.md`, 'body');
    drive.before = (method) => {
      if (method === 'updateContent') throw googleError(undefined, undefined, 'socket hang up');
    };
    const error = await expectError(storage.append(p('a.md'), () => 'x'), ProviderApiError);
    expect(error.message).toContain(`could not confirm whether the text was appended to "obsidian:${K}/a.md"`);
    expect(drive.callsOf('updateContent')).toHaveLength(1);
  });

  it('reports a file that disappears before the write as not found', async () => {
    drive.write(`${K}/a.md`, 'body');
    drive.before = (method) => {
      if (method === 'revisionOf') throw googleError(404, 'notFound');
    };
    await expectError(storage.append(p('a.md'), () => 'x'), NotFoundError);
  });

  it('does not write a file larger than 5 MiB', async () => {
    drive.write(`${K}/big.md`, 'x'.repeat(5 * 1024 * 1024 - 2));
    await expectError(storage.append(p('big.md'), () => 'abc'), InputValidationError).then((e) =>
      expect(e.message).toContain('5 MiB'),
    );
    expect(drive.callsOf('updateContent')).toHaveLength(0);
  });

  it('never creates a missing file', async () => {
    await expectError(storage.append(p('missing.md'), () => 'x'), NotFoundError);
    expect(drive.callsOf('createFile')).toHaveLength(0);
  });
});

describe('createExclusive', () => {
  it('creates a Markdown file with the text as UTF-8 directly in the knowledge directory', async () => {
    await storage.createExclusive(p('新規 メモ.md'), '---\ntitle: 新規\n---\n本文\n');
    const id = drive.idAt(`${K}/新規 メモ.md`);
    expect(drive.text(id)).toBe('---\ntitle: 新規\n---\n本文\n');
    expect(drive.mimeTypeOf(id)).toBe('text/markdown');
  });

  it.each([
    ['the same name', 'Note.md', 'Note.md', false],
    ['another case', 'note.md', 'NOTE.md', false],
    ['another Unicode normalization', 'Café.md', 'Café.md', false],
    ['a folder of that name', 'Folder.md', 'Folder.md', true],
  ])('never overwrites: %s already there is a conflict', async (_label, existing, created, isFolder) => {
    if (isFolder) drive.mkdirs(`${K}/${existing}`);
    else drive.write(`${K}/${existing}`, 'existing');
    const before = drive.count;
    const error = await expectError(storage.createExclusive(p(created), 'new'), ConflictError);
    expect(error.message).toContain('already exists; use knowledge_search and knowledge_append');
    expect(drive.count).toBe(before);
    expect(drive.callsOf('createFile')).toHaveLength(0);
  });

  it('serializes creates of one name in this process: the second sees the first', async () => {
    const results = await Promise.allSettled([
      storage.createExclusive(p('a.md'), 'first'),
      storage.createExclusive(p('A.md'), 'second'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect(drive.named(drive.idAt(K), 'a.md')).toHaveLength(1);
    expect(drive.named(drive.idAt(K), 'A.md')).toHaveLength(0);
  });

  it('runs creates of different names in parallel', async () => {
    let inFlight = 0;
    let most = 0;
    drive.before = async (method) => {
      if (method !== 'createFile') return;
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    };
    await Promise.all([storage.createExclusive(p('a.md'), 'a'), storage.createExclusive(p('b.md'), 'b')]);
    expect(most).toBe(2);
  });

  it('does not make names unique when a listing lags behind a create (both are created)', async () => {
    drive.lagCreates = true;
    await storage.createExclusive(p('a.md'), 'first');
    await storage.createExclusive(p('a.md'), 'second');
    drive.settle();
    expect(drive.named(drive.idAt(K), 'a.md')).toHaveLength(2);
    // Afterwards the duplicate is never resolved to one of them.
    await expectError(storage.read(p('a.md')), ConflictError);
    await expectError(storage.append(p('a.md'), () => 'x'), ConflictError);
    await expectError(storage.list(), ConflictError);
    await expectError(storage.createExclusive(p('a.md'), 'third'), ConflictError);
  });

  it('reports a lagging first create seen after the second is created, keeping both', async () => {
    drive.lagCreates = true;
    await storage.createExclusive(p('a.md'), 'first');
    drive.lagCreates = false;
    drive.before = (method) => {
      if (method === 'createFile') drive.settle(); // the first becomes visible before the second checks again
    };
    const error = await expectError(storage.createExclusive(p('a.md'), 'second'), ConflictError);
    expect(error.message).toContain(`"obsidian:${K}/a.md" was created, but its Google Drive folder has another item`);
    expect(drive.named(drive.idAt(K), 'a.md')).toHaveLength(2);
  });

  it.each([
    ['between the check and the create', 'createFile'],
    ['between the create and the check after it', 'after-create'],
  ] as const)('detects another writer creating the name %s, and removes nothing', async (_label, when) => {
    let creates = 0;
    drive.before = (method) => {
      if (method === 'createFile') creates += 1;
      const now = when === 'createFile' ? method === 'createFile' : method === 'listChildren' && creates === 1;
      if (now && drive.named(drive.idAt(K), 'a.md').length < 2) drive.write(`${K}/a.md`, 'from Drive for desktop');
    };
    const error = await expectError(storage.createExclusive(p('a.md'), 'from AI'), ConflictError);
    expect(error.message).toContain('was created');
    const files = drive.named(drive.idAt(K), 'a.md');
    expect(files).toHaveLength(2);
    expect(files.map((f) => drive.text(f.id)).sort()).toEqual(['from AI', 'from Drive for desktop']);
  });

  it('leaves names that differ only in case or normalization usable by exact ID, and refuses to create another', async () => {
    drive.write(`${K}/Tokyo.md`, 'upper');
    drive.write(`${K}/tokyo.md`, 'lower');
    expect((await storage.read(p('Tokyo.md'))).text).toBe('upper');
    expect((await storage.read(p('tokyo.md'))).text).toBe('lower');
    await storage.append(p('tokyo.md'), () => ' more');
    unchanged(`${K}/tokyo.md`, 'lower more');
    expect((await storage.list()).map((e) => e.path).sort()).toEqual([p('Tokyo.md'), p('tokyo.md')]);
    await expectError(storage.createExclusive(p('TOKYO.md'), 'x'), ConflictError);
  });

  it('says the result is unknown when the create gets no answer, without trying again', async () => {
    drive.before = (method) => {
      if (method === 'createFile') throw googleError(503);
    };
    const error = await expectError(storage.createExclusive(p('a.md'), 'x'), ProviderApiError);
    expect(error.message).toContain(`could not confirm whether "obsidian:${K}/a.md" was created`);
    expect(drive.callsOf('createFile')).toHaveLength(1);
  });

  it('says the file was created when checking afterwards fails', async () => {
    let lists = 0;
    drive.before = (method) => {
      if (method === 'listChildren' && drive.callsOf('createFile').length === 1 && ++lists === 1) throw googleError(500);
    };
    const error = await expectError(storage.createExclusive(p('a.md'), 'x'), ProviderApiError);
    expect(error.message).toContain('was created, but checking the folder');
    expect(drive.named(drive.idAt(K), 'a.md')).toHaveLength(1);
  });

  it('does not write a file larger than 5 MiB', async () => {
    await expectError(storage.createExclusive(p('big.md'), 'x'.repeat(5 * 1024 * 1024 + 1)), InputValidationError);
    expect(drive.callsOf('createFile')).toHaveLength(0);
  });
});

describe('life log storage', () => {
  const NAME = '2026-10-03-東京散策.md';

  it('creates, reads and appends to a file directly in the life log folder', async () => {
    await lifelog.createExclusive(NAME, '# 東京散策\n');
    await lifelog.append(NAME, (file) => {
      expect(file).toEqual({ name: NAME, text: '# 東京散策\n' });
      return '\n夕食\n';
    });
    expect(await lifelog.read(NAME)).toEqual({ name: NAME, text: '# 東京散策\n\n夕食\n' });
    expect(lifelog.refOf(NAME)).toBe(`${L}/${NAME}`);
  });

  it('refuses a file that is not valid UTF-8, and never writes to it', async () => {
    const id = drive.write(`${L}/${NAME}`, Buffer.from([0x82, 0xa0, 0x0a]));
    const error = await expectError(lifelog.read(NAME), ProviderApiError);
    expect(error.message).toContain(`life log "lifelog:${NAME}" is not valid UTF-8`);
    await expectError(lifelog.append(NAME, () => 'x'), ProviderApiError);
    expect(drive.bytes(id)).toEqual(Buffer.from([0x82, 0xa0, 0x0a]));
    expect(drive.callsOf('updateContent')).toHaveLength(0);
  });

  it('uses its own messages for conflicts and missing files', async () => {
    drive.write(`${L}/${NAME}`, 'x');
    await expectError(lifelog.createExclusive(NAME, 'y'), ConflictError).then((e) =>
      expect(e.message).toContain('choose another title, or use lifelog_append'),
    );
    await expectError(lifelog.read('2026-10-04-missing.md'), NotFoundError).then((e) =>
      expect(e.message).toContain('"lifelog:2026-10-04-missing.md" was not found'),
    );
  });

  it('shares the create lock with knowledge, keyed by folder', async () => {
    await Promise.all([lifelog.createExclusive(NAME, 'a'), storage.createExclusive(p(NAME), 'b')]);
    expect(drive.named(drive.idAt(L), NAME)).toHaveLength(1);
    expect(drive.named(drive.idAt(K), NAME)).toHaveLength(1);
  });
});

it('never deletes, trashes or renames anything', async () => {
  drive.write(`${K}/a.md`, 'a');
  drive.lagCreates = true;
  await storage.createExclusive(p('b.md'), 'b');
  await storage.createExclusive(p('b.md'), 'b');
  drive.settle();
  await storage.createExclusive(p('b.md'), 'c').catch(() => undefined);
  await storage.append(p('a.md'), () => 'more').catch(() => undefined);
  const methods = new Set(drive.calls.map((c) => c.method));
  expect([...methods].sort()).toEqual(
    ['createFile', 'downloadRevision', 'getItem', 'listChildren', 'revisionOf', 'updateContent'].sort(),
  );
});
