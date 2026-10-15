import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../errors.js';
import { isKnowledgeFileName, isValidSegment, quoteId, segmentsBelow, type VaultPath, vaultPathBelow } from './id.js';
import type { VaultFile, VaultStorage } from './storage.js';

export interface FilesystemVaultStorageOptions {
  /** `sources.knowledge.obsidian.vault_path`: absolute path of the vault. */
  vaultPath: string | undefined;
  /** `sources.knowledge.obsidian.knowledge_dir`: vault-relative, `/`-separated. */
  knowledgeDir: string | undefined;
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const isMissing = (error: unknown) => errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR';

/** True when `target` is strictly inside `root` (both real paths). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Vault storage on the local file system (the vault may sit in a sync folder such as Google Drive;
 * syncing is not managed here). The only place that touches `node:fs` and real OS paths.
 *
 * Boundary: symbolic links and junctions are allowed only at or above the configured vault root.
 * From the vault root down to knowledge_dir, and inside it, links are rejected (never followed), and
 * real paths are checked to stay inside. Nothing is cached: every call sees the current files.
 */
export class FilesystemVaultStorage implements VaultStorage {
  constructor(private readonly options: FilesystemVaultStorageOptions) {}

  async checkKnowledgeDir(): Promise<void> {
    await this.knowledgeRoot();
  }

  async list(): Promise<{ path: VaultPath; modifiedAt: number }[]> {
    const { root, knowledgeDir } = await this.knowledgeRoot();
    const files: { path: VaultPath; modifiedAt: number }[] = [];
    // Iterative walk: no recursion depth to run out of, and links are never followed, so no cycles.
    const pending: string[][] = [[]];
    for (let segments = pending.pop(); segments; segments = pending.pop()) {
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, ...segments), { withFileTypes: true });
      } catch (error) {
        if (segments.length > 0 && isMissing(error)) continue; // removed while searching
        throw this.fsError(error, 'cannot list the knowledge directory');
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !isValidSegment(entry.name)) continue;
        const child = [...segments, entry.name];
        if (entry.isDirectory()) {
          pending.push(child);
        } else if (entry.isFile() && isKnowledgeFileName(entry.name)) {
          try {
            const { mtimeMs } = await stat(join(root, ...child));
            files.push({ path: vaultPathBelow(knowledgeDir, child), modifiedAt: mtimeMs });
          } catch (error) {
            if (!isMissing(error)) throw this.fsError(error, 'cannot list the knowledge directory');
          }
        }
      }
    }
    return files;
  }

  async read(path: VaultPath): Promise<VaultFile> {
    const target = await this.existingFile(path);
    try {
      const [text, info] = await Promise.all([readFile(target, 'utf8'), stat(target)]);
      return { path, text: text.replace(/^﻿/, ''), modifiedAt: info.mtimeMs };
    } catch (error) {
      if (isMissing(error)) throw notFound(path, error);
      throw this.fsError(error, `cannot read ${quoteId(path)}`);
    }
  }

  async createExclusive(path: VaultPath, text: string): Promise<void> {
    const { root, knowledgeDir } = await this.knowledgeRoot();
    const segments = segmentsBelow(path, knowledgeDir);
    const parent = await this.walk(root, segments.slice(0, -1), path);
    const target = join(parent, segments.at(-1)!);

    let handle;
    try {
      // O_CREAT | O_EXCL: fails if anything (file, directory, link) exists, atomically.
      handle = await open(target, 'wx');
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'EEXIST') {
        throw new InputValidationError(
          `knowledge ${quoteId(path)} already exists; use knowledge_search and knowledge_append to add to it`,
          { cause: error },
        );
      }
      if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
        throw new InputValidationError(`the file name for ${quoteId(path)} is not usable here; change the title`, {
          cause: error,
        });
      }
      if (isMissing(error)) throw this.missingKnowledgeDir(error);
      throw this.fsError(error, `cannot create ${quoteId(path)}`);
    }
    try {
      await handle.writeFile(text, 'utf8');
      await handle.close();
    } catch (error) {
      // Never leave a half-written note behind.
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw this.fsError(error, `cannot write ${quoteId(path)}`);
    }
  }

  async append(path: VaultPath, text: string): Promise<void> {
    const target = await this.existingFile(path);
    let handle;
    try {
      // No O_CREAT: a file moved or deleted since it was read is not recreated.
      handle = await open(target, constants.O_WRONLY | constants.O_APPEND);
    } catch (error) {
      if (isMissing(error)) throw notFound(path, error);
      throw this.fsError(error, `cannot write ${quoteId(path)}`);
    }
    try {
      await handle.writeFile(text, 'utf8');
    } catch (error) {
      throw this.fsError(error, `cannot write ${quoteId(path)}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Real path of knowledge_dir, checked to be a directory reached from the vault root without links. */
  private async knowledgeRoot(): Promise<{ root: string; knowledgeDir: string }> {
    const { vaultPath, knowledgeDir } = this.options;
    if (!vaultPath) throw new ConfigurationError('sources.knowledge.obsidian.vault_path is not set');
    if (!knowledgeDir) throw new ConfigurationError('sources.knowledge.obsidian.knowledge_dir is not set');

    let vaultReal: string;
    try {
      vaultReal = await realpath(resolve(vaultPath));
      if (!(await stat(vaultReal)).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    } catch (error) {
      throw new ConfigurationError(
        'the Obsidian vault (sources.knowledge.obsidian.vault_path) does not exist or cannot be read',
        { cause: error },
      );
    }

    const notUsable = (reason: string, cause?: unknown) =>
      new ConfigurationError(`the knowledge directory "${knowledgeDir}" ${reason}`, { cause });
    let current = vaultReal;
    for (const segment of knowledgeDir.split('/')) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        throw notUsable('does not exist in the vault or cannot be read', error);
      }
      if (info.isSymbolicLink()) throw notUsable('goes through a symbolic link or junction, which is not supported');
      if (!info.isDirectory()) throw notUsable('does not exist in the vault');
    }
    let root: string;
    try {
      root = await realpath(current);
    } catch (error) {
      throw notUsable('does not exist in the vault or cannot be read', error);
    }
    if (!isInside(vaultReal, root)) throw notUsable('is not inside the vault');
    return { root, knowledgeDir };
  }

  /** Real path of the regular file at `path`, reached from knowledge_dir without links. */
  private async existingFile(path: VaultPath): Promise<string> {
    const { root, knowledgeDir } = await this.knowledgeRoot();
    const segments = segmentsBelow(path, knowledgeDir);
    const parent = await this.walk(root, segments.slice(0, -1), path);
    const target = join(parent, segments.at(-1)!);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isMissing(error)) throw notFound(path, error);
      throw this.fsError(error, `cannot read ${quoteId(path)}`);
    }
    if (info.isSymbolicLink()) throw throughLink(path);
    if (!info.isFile()) throw notFound(path);
    await this.assertInside(root, target, path);
    return target;
  }

  /** Follows directory `segments` from `root`, rejecting links; returns the real directory path. */
  private async walk(root: string, segments: string[], path: VaultPath): Promise<string> {
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (isMissing(error)) throw notFound(path, error);
        throw this.fsError(error, `cannot read ${quoteId(path)}`);
      }
      if (info.isSymbolicLink()) throw throughLink(path);
      if (!info.isDirectory()) throw notFound(path);
    }
    if (segments.length > 0) await this.assertInside(root, current, path);
    return current;
  }

  private async assertInside(root: string, target: string, path: VaultPath): Promise<void> {
    let real: string;
    try {
      real = await realpath(target);
    } catch (error) {
      if (isMissing(error)) throw notFound(path, error);
      throw this.fsError(error, `cannot read ${quoteId(path)}`);
    }
    if (!isInside(root, real)) throw new InputValidationError(`${quoteId(path)} is outside the knowledge directory`);
  }

  private missingKnowledgeDir(cause: unknown): ConfigurationError {
    return new ConfigurationError(`the knowledge directory "${this.options.knowledgeDir}" does not exist in the vault`, {
      cause,
    });
  }

  /** errno messages contain absolute paths: only the code is shown, the error is kept as `cause`. */
  private fsError(error: unknown, message: string): ProviderApiError {
    return new ProviderApiError('Obsidian', `${message} (${errnoOf(error) ?? 'filesystem error'})`, { cause: error });
  }
}

function notFound(path: VaultPath, cause?: unknown): NotFoundError {
  return new NotFoundError(
    `knowledge ${quoteId(path)} was not found; it may have been moved or deleted — search again with knowledge_search`,
    cause === undefined ? undefined : { cause },
  );
}

function throughLink(path: VaultPath): InputValidationError {
  return new InputValidationError(`${quoteId(path)} goes through a symbolic link or junction, which is not supported`);
}
