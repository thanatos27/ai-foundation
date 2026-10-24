import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigurationError, InputValidationError, type NotFoundError, ProviderApiError } from '../../errors.js';
import { isValidSegment } from './id.js';

/**
 * What a caller calls its directory and how its errors read. Segments are relative to the
 * directory; messages built from them must never contain an absolute OS path.
 */
export interface VaultDirectoryLabels {
  /** The config key of the directory, e.g. `sources.knowledge.obsidian.knowledge_dir`. */
  dirConfigKey: string;
  /** e.g. `knowledge directory`. */
  dirName: string;
  /** How a file is quoted in messages, e.g. `"obsidian:AI Foundation/Knowledge/x.md"`. */
  quote(segments: readonly string[]): string;
  notFound(segments: readonly string[], cause?: unknown): NotFoundError;
  alreadyExists(segments: readonly string[], cause: unknown): InputValidationError;
}

export interface FilesystemVaultDirectoryOptions {
  /** `sources.knowledge.obsidian.vault_path`: absolute path of the vault. */
  vaultPath: string | undefined;
  /** Vault-relative, `/`-separated: the only directory read and written. */
  dir: string | undefined;
  labels: VaultDirectoryLabels;
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const isMissing = (error: unknown) => errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR';

/** True when `target` is strictly inside `root` (both real paths). `..note.md` is a name, not a parent. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Whether a directory entry name is a Markdown file name: `<name>.md` (lowercase extension, non-empty name). */
function isMarkdownFileName(name: string): boolean {
  return isValidSegment(name) && name.endsWith('.md') && name.length > '.md'.length;
}

/**
 * The file system below one directory of the vault (the vault may sit in a sync folder such as
 * Google Drive; syncing is not managed here). The only place that touches `node:fs` and real OS paths.
 *
 * Boundary: symbolic links and junctions are allowed only at or above the configured vault root.
 * From the vault root down to the directory, and inside it, links are rejected (never followed), and
 * real paths are checked to stay inside. Nothing is cached: every call sees the current files.
 *
 * Segments passed in are relative to the directory and already valid (callers parse their IDs
 * first). Files are read as bytes: decoding is the caller's choice. Nothing here truncates, renames
 * or replaces an existing file.
 */
export class FilesystemVaultDirectory {
  constructor(private readonly options: FilesystemVaultDirectoryOptions) {}

  async check(): Promise<void> {
    await this.root();
  }

  /** Every regular .md file below the directory, recursively, at any depth (links are not followed). */
  async list(): Promise<{ segments: string[]; modifiedAt: number }[]> {
    const root = await this.root();
    const files: { segments: string[]; modifiedAt: number }[] = [];
    // Iterative walk: no recursion depth to run out of, and links are never followed, so no cycles.
    const pending: string[][] = [[]];
    for (let segments = pending.pop(); segments; segments = pending.pop()) {
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, ...segments), { withFileTypes: true });
      } catch (error) {
        if (segments.length > 0 && isMissing(error)) continue; // removed while searching
        throw this.fsError(error, `cannot list the ${this.options.labels.dirName}`);
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !isValidSegment(entry.name)) continue;
        const child = [...segments, entry.name];
        if (entry.isDirectory()) {
          pending.push(child);
        } else if (entry.isFile() && isMarkdownFileName(entry.name)) {
          try {
            const { mtimeMs } = await stat(join(root, ...child));
            files.push({ segments: child, modifiedAt: mtimeMs });
          } catch (error) {
            if (!isMissing(error)) throw this.fsError(error, `cannot list the ${this.options.labels.dirName}`);
          }
        }
      }
    }
    return files;
  }

  /** The bytes of the regular file at `segments`, as stored (a byte order mark is kept). */
  async read(segments: readonly string[]): Promise<{ bytes: Buffer; modifiedAt: number }> {
    const target = await this.existingFile(segments);
    try {
      const [bytes, info] = await Promise.all([readFile(target), stat(target)]);
      return { bytes, modifiedAt: info.mtimeMs };
    } catch (error) {
      if (isMissing(error)) throw this.options.labels.notFound(segments, error);
      throw this.fsError(error, `cannot read ${this.options.labels.quote(segments)}`);
    }
  }

  /** Creates the file as UTF-8; `labels.alreadyExists` when anything is already there. Never overwrites. */
  async createExclusive(segments: readonly string[], text: string): Promise<void> {
    const root = await this.root();
    const parent = await this.walk(root, segments.slice(0, -1), segments);
    const target = join(parent, segments.at(-1)!);
    const quoted = () => this.options.labels.quote(segments);

    let handle;
    try {
      // O_CREAT | O_EXCL: fails if anything (file, directory, link) exists, atomically.
      handle = await open(target, 'wx');
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'EEXIST') throw this.options.labels.alreadyExists(segments, error);
      if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
        throw new InputValidationError(`the file name for ${quoted()} is not usable here; change the title`, {
          cause: error,
        });
      }
      if (isMissing(error)) throw this.missingDir(error);
      throw this.fsError(error, `cannot create ${quoted()}`);
    }
    try {
      await handle.writeFile(text, 'utf8');
      await handle.close();
    } catch (error) {
      // Never leave a half-written file behind.
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw this.fsError(error, `cannot write ${quoted()}`);
    }
  }

  /** Adds `text` (UTF-8) to the end of the existing file and changes nothing else. */
  async append(segments: readonly string[], text: string): Promise<void> {
    const target = await this.existingFile(segments);
    const quoted = () => this.options.labels.quote(segments);
    let handle;
    try {
      // No O_CREAT: a file moved or deleted since it was read is not recreated.
      handle = await open(target, constants.O_WRONLY | constants.O_APPEND);
    } catch (error) {
      if (isMissing(error)) throw this.options.labels.notFound(segments, error);
      throw this.fsError(error, `cannot write ${quoted()}`);
    }
    try {
      await handle.writeFile(text, 'utf8');
    } catch (error) {
      throw this.fsError(error, `cannot write ${quoted()}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Real path of the directory, checked to be a directory reached from the vault root without links. */
  private async root(): Promise<string> {
    const { vaultPath, dir, labels } = this.options;
    if (!vaultPath) throw new ConfigurationError('sources.knowledge.obsidian.vault_path is not set');
    if (!dir) throw new ConfigurationError(`${labels.dirConfigKey} is not set`);

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
      new ConfigurationError(`the ${labels.dirName} "${dir}" ${reason}`, { cause });
    let current = vaultReal;
    for (const segment of dir.split('/')) {
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
    return root;
  }

  /** Real path of the regular file at `segments`, reached from the directory without links. */
  private async existingFile(segments: readonly string[]): Promise<string> {
    const root = await this.root();
    const parent = await this.walk(root, segments.slice(0, -1), segments);
    const target = join(parent, segments.at(-1)!);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isMissing(error)) throw this.options.labels.notFound(segments, error);
      throw this.fsError(error, `cannot read ${this.options.labels.quote(segments)}`);
    }
    if (info.isSymbolicLink()) throw this.throughLink(segments);
    if (!info.isFile()) throw this.options.labels.notFound(segments);
    await this.assertInside(root, target, segments);
    return target;
  }

  /** Follows directory `dirs` from `root`, rejecting links; returns the real directory path. */
  private async walk(root: string, dirs: readonly string[], segments: readonly string[]): Promise<string> {
    let current = root;
    for (const segment of dirs) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (isMissing(error)) throw this.options.labels.notFound(segments, error);
        throw this.fsError(error, `cannot read ${this.options.labels.quote(segments)}`);
      }
      if (info.isSymbolicLink()) throw this.throughLink(segments);
      if (!info.isDirectory()) throw this.options.labels.notFound(segments);
    }
    if (dirs.length > 0) await this.assertInside(root, current, segments);
    return current;
  }

  private async assertInside(root: string, target: string, segments: readonly string[]): Promise<void> {
    let real: string;
    try {
      real = await realpath(target);
    } catch (error) {
      if (isMissing(error)) throw this.options.labels.notFound(segments, error);
      throw this.fsError(error, `cannot read ${this.options.labels.quote(segments)}`);
    }
    if (!isInside(root, real)) {
      throw new InputValidationError(`${this.options.labels.quote(segments)} is outside the ${this.options.labels.dirName}`);
    }
  }

  private throughLink(segments: readonly string[]): InputValidationError {
    return new InputValidationError(
      `${this.options.labels.quote(segments)} goes through a symbolic link or junction, which is not supported`,
    );
  }

  private missingDir(cause: unknown): ConfigurationError {
    return new ConfigurationError(`the ${this.options.labels.dirName} "${this.options.dir}" does not exist in the vault`, {
      cause,
    });
  }

  /** errno messages contain absolute paths: only the code is shown, the error is kept as `cause`. */
  private fsError(error: unknown, message: string): ProviderApiError {
    return new ProviderApiError('Obsidian', `${message} (${errnoOf(error) ?? 'filesystem error'})`, { cause: error });
  }
}
