import { ConfigurationError, ConflictError, errorText, InputValidationError, ProviderApiError } from '../../errors.js';
import {
  DRIVE_FOLDER_MIME,
  DRIVE_SHORTCUT_MIME,
  type DriveApi,
  type DriveErrorOptions,
  type DriveItem,
  isGoogleAppsType,
  StaleRevisionError,
  toDriveError,
} from '../google-drive/client.js';
import { createKey, type DriveCreateLock } from './drive-create-lock.js';
import { isValidSegment } from './id.js';
import type { VaultDirectoryLabels } from './vault-directory.js';

/**
 * The most AI Foundation writes to one file in Google Drive. Not a Drive limit: media and multipart
 * uploads are meant for files up to 5 MB, and resumable uploads are not implemented.
 */
export const MAX_DRIVE_FILE_BYTES = 5 * 1024 * 1024;
/** Ambiguous paths named in the search error. */
const MAX_REPORTED = 10;

export interface DriveVaultDirectoryOptions {
  api: () => Promise<DriveApi>;
  /** `sources.knowledge.obsidian.vault_folder_id`: the vault's root folder. */
  vaultFolderId: string | undefined;
  /** Vault-relative, `/`-separated: the only folder read and written. */
  dir: string | undefined;
  labels: VaultDirectoryLabels;
  /** Shared by every Drive storage of the process (`createConnectors`). */
  createLock: DriveCreateLock;
  /** Folders of the vault `dir` must be apart from (not the same, inside or containing), by folder ID. */
  apartFrom?: { dir: string | undefined; dirName: string }[];
}

/** A file's bytes as stored (a byte order mark is kept) and its modification time in epoch milliseconds. */
export interface DriveFileContent {
  bytes: Buffer;
  modifiedAt: number;
}

export interface DriveListedFile {
  segments: string[];
  modifiedAt: number;
  /** Reads the file found by this listing, by its ID. */
  read(): Promise<DriveFileContent>;
}

const isFolder = (item: DriveItem) => item.mimeType === DRIVE_FOLDER_MIME;
const isShortcut = (item: DriveItem) => item.mimeType === DRIVE_SHORTCUT_MIME;
/** A file with bytes behind it (not a folder, shortcut or Google Doc). The MIME type says nothing more. */
const isRegularFile = (item: DriveItem) => !isGoogleAppsType(item.mimeType);
const isMarkdownFileName = (name: string) => isValidSegment(name) && name.endsWith('.md') && name.length > '.md'.length;
const modifiedAt = (item: DriveItem) => Date.parse(item.modifiedTime) || 0;

/** Thrown inside `walk` for an `apartFrom` folder that does not resolve: that folder is skipped. */
class Unresolved extends Error {}

/**
 * One folder of the vault in Google Drive — the Drive counterpart of `FilesystemVaultDirectory`,
 * with the same boundary rules: everything is reached by name from the vault's root folder,
 * shortcuts are never followed, trashed items are never seen, and an item is used only when its name
 * is unique in its folder (Drive allows several). Nothing is cached: every call resolves again.
 *
 * Nothing here deletes, trashes, renames or replaces a file. Messages name Foundation IDs (through
 * `labels`), never a Drive ID or a token.
 */
export class DriveVaultDirectory {
  constructor(private readonly options: DriveVaultDirectoryOptions) {}

  async check(): Promise<void> {
    await this.root();
  }

  /**
   * Every Markdown file below the folder, at any depth. A name that several items share in one
   * folder makes the paths through it ambiguous: the whole listing is a ConflictError then, rather
   * than leaving files out.
   */
  async list(): Promise<DriveListedFile[]> {
    const { api, folderId } = await this.root();
    const { labels } = this.options;
    const files: DriveListedFile[] = [];
    const ambiguous: string[][] = [];
    const pending: { id: string; segments: string[] }[] = [{ id: folderId, segments: [] }];
    for (let folder = pending.pop(); folder; folder = pending.pop()) {
      const children = await this.call(() => api.listChildren(folder.id), `cannot list the ${labels.dirName}`);
      for (const [name, items] of groupByName(children)) {
        if (!isValidSegment(name)) continue; // no knowledge ID can name it
        const relevant = items.some((item) => isFolder(item) || (isRegularFile(item) && isMarkdownFileName(name)));
        if (!relevant) continue;
        const segments = [...folder.segments, name];
        if (items.length > 1) {
          ambiguous.push(segments);
          continue;
        }
        const item = items[0]!;
        if (isFolder(item)) pending.push({ id: item.id, segments });
        else if (isRegularFile(item) && isMarkdownFileName(name)) {
          files.push({ segments, modifiedAt: modifiedAt(item), read: () => this.download(api, item, segments) });
        }
      }
    }
    if (ambiguous.length > 0) {
      const shown = ambiguous.slice(0, MAX_REPORTED).map((segments) => labels.quote(segments));
      const more = ambiguous.length > MAX_REPORTED ? `, and ${ambiguous.length - MAX_REPORTED} more` : '';
      throw new ConflictError(
        `the ${labels.dirName} has ${ambiguous.length} path(s) that name several items in Google Drive: ${shown.join(', ')}${more}; ` +
          'rename or remove the duplicates in Google Drive',
      );
    }
    return files;
  }

  async read(segments: readonly string[]): Promise<DriveFileContent> {
    const { api, folderId } = await this.root();
    const item = await this.resolveFile(api, folderId, segments);
    return this.download(api, item, segments);
  }

  /**
   * Creates the file as UTF-8 (`labels.alreadyExists` when the folder already has the name,
   * ignoring case and Unicode normalization). Creates of one name are serialized in this process,
   * and the folder is checked again afterwards: another item with the name then is a ConflictError
   * saying the file was created. The created file is never removed.
   */
  async createExclusive(segments: readonly string[], text: string): Promise<void> {
    const { api, folderId } = await this.root();
    const { labels } = this.options;
    const quoted = labels.quote(segments);
    const parentId = await this.resolveParent(api, folderId, segments);
    const name = segments.at(-1)!;
    this.assertSize(Buffer.byteLength(text, 'utf8'), segments);

    await this.options.createLock.run(parentId, name, async () => {
      if ((await this.sameName(api, parentId, name, segments)).length > 0) throw labels.alreadyExists(segments, undefined);

      let created: DriveItem;
      try {
        created = await api.createFile(parentId, name, text);
      } catch (error) {
        throw toDriveError(error, {
          context: `cannot create ${quoted}`,
          unknownResult: `could not confirm whether ${quoted} was created; look for it before trying again`,
        });
      }

      let after: DriveItem[];
      try {
        after = await this.sameName(api, parentId, name, segments);
      } catch (error) {
        throw new ProviderApiError(
          'Google Drive',
          [`${quoted} was created, but checking the folder for other items with the same name failed: `, errorText(error)],
          { cause: error },
        );
      }
      if (after.some((item) => item.id !== created.id)) {
        throw new ConflictError(
          `${quoted} was created, but its Google Drive folder has another item with the same name (ignoring case); ` +
            'check them in Google Drive and keep one',
        );
      }
    });
  }

  /**
   * Adds the text `compose` returns to the end of the file, against the revision it read: the
   * content of that revision is downloaded, and the write is conditional on its etag, so a change
   * made in between (that updated the file's etag) is a ConflictError and nothing is written. The
   * bytes read are written back as they were; only the UTF-8 of the text is added.
   */
  async append(segments: readonly string[], compose: (content: DriveFileContent) => string): Promise<DriveFileContent> {
    const { api, folderId } = await this.root();
    const { labels } = this.options;
    const quoted = labels.quote(segments);
    const { item, parentId } = await this.resolve(api, folderId, segments);
    const read = { notFound: () => labels.notFound(segments), context: `cannot read ${quoted}` };
    const revision = await this.call(() => api.revisionOf(item.id), read);
    // The write goes to the file ID: it must still be the file at this path. Renamed, trashed or
    // moved since it was resolved (possibly out of the folder), it is not written to.
    if (revision.trashed || revision.name !== item.name || !revision.parentIds.includes(parentId)) {
      throw labels.notFound(segments);
    }
    const bytes = await this.call(() => api.downloadRevision(revision), read);
    const content = { bytes, modifiedAt: modifiedAt(item) };

    const next = Buffer.concat([bytes, Buffer.from(compose(content), 'utf8')]);
    this.assertSize(next.length, segments);
    try {
      await api.updateContent(revision, next);
    } catch (error) {
      if (error instanceof StaleRevisionError) {
        throw new ConflictError(`${quoted} changed in Google Drive after it was read, so nothing was appended; try again`, {
          cause: error,
        });
      }
      throw toDriveError(error, {
        notFound: () => labels.notFound(segments, error),
        context: `cannot write ${quoted}`,
        unknownResult: `could not confirm whether the text was appended to ${quoted}; read it again before trying again`,
      });
    }
    return content;
  }

  // -------------------------------------------------------------------------------------------

  private async download(api: DriveApi, item: DriveItem, segments: readonly string[]): Promise<DriveFileContent> {
    const { labels } = this.options;
    const bytes = await this.call(() => api.download(item.id), {
      notFound: () => labels.notFound(segments),
      context: `cannot read ${labels.quote(segments)}`,
    });
    return { bytes, modifiedAt: modifiedAt(item) };
  }

  /** The vault's root folder, then the configured folder (checked apart from the others). */
  private async root(): Promise<{ api: DriveApi; folderId: string }> {
    const { vaultFolderId, dir, labels } = this.options;
    if (!vaultFolderId) throw new ConfigurationError('sources.knowledge.obsidian.vault_folder_id is not set');
    if (!dir) throw new ConfigurationError(`${labels.dirConfigKey} is not set`);
    const api = await this.options.api();

    const vaultError = (reason: string, cause?: unknown) =>
      new ConfigurationError(`the Obsidian vault folder (sources.knowledge.obsidian.vault_folder_id) ${reason}`, { cause });
    const vault = await this.call(() => api.getItem(vaultFolderId), {
      notFound: () => vaultError('does not exist in Google Drive or cannot be read'),
      context: 'cannot read the Obsidian vault folder',
    });
    if (isShortcut(vault)) throw vaultError('is a Google Drive shortcut, which is not supported; use the folder itself');
    if (!isFolder(vault)) throw vaultError('is not a folder');
    if (vault.trashed) throw vaultError('is in the trash');

    const notUsable = (reason: string) => new ConfigurationError(`the ${labels.dirName} "${dir}" ${reason}`);
    const chain = await this.walk(api, vault.id, dir, labels.dirName, notUsable);

    for (const other of this.options.apartFrom ?? []) {
      if (!other.dir) continue;
      let otherChain: string[];
      try {
        otherChain = await this.walk(api, vault.id, other.dir, other.dirName, () => new Unresolved());
      } catch (error) {
        if (error instanceof Unresolved) continue; // missing: the tools of that folder report it
        throw error;
      }
      if (otherChain.includes(chain.at(-1)!) || chain.includes(otherChain.at(-1)!)) {
        throw notUsable(`is the same folder as, inside or contains the ${other.dirName} "${other.dir}"; use separate folders`);
      }
    }
    return { api, folderId: chain.at(-1)! };
  }

  /** Folder IDs from the vault root (excluded) down to `dir`, each a unique, untrashed folder that is not a shortcut. */
  private async walk(
    api: DriveApi,
    vaultId: string,
    dir: string,
    dirName: string,
    notUsable: (reason: string) => Error,
  ): Promise<string[]> {
    const chain: string[] = [];
    let current = vaultId;
    for (const segment of dir.split('/')) {
      const items = (await this.call(() => api.listChildren(current, { name: segment }), `cannot read the ${dirName}`)).filter(
        (item) => item.name === segment,
      );
      if (items.length === 0) throw notUsable('does not exist in the vault');
      if (items.length > 1) throw notUsable('names several items in Google Drive; rename or remove the duplicates');
      const item = items[0]!;
      if (isShortcut(item)) throw notUsable('goes through a Google Drive shortcut, which is not supported');
      if (!isFolder(item)) throw notUsable('does not exist in the vault');
      current = item.id;
      chain.push(current);
    }
    return chain;
  }

  /** The regular file at `segments` below the folder: every step must be a unique name. */
  private async resolveFile(api: DriveApi, folderId: string, segments: readonly string[]): Promise<DriveItem> {
    return (await this.resolve(api, folderId, segments)).item;
  }

  /** `resolveFile`, with the folder the file was found in. */
  private async resolve(
    api: DriveApi,
    folderId: string,
    segments: readonly string[],
  ): Promise<{ item: DriveItem; parentId: string }> {
    const parentId = await this.resolveParent(api, folderId, segments);
    const item = await this.unique(api, parentId, segments.at(-1)!, segments);
    if (!isRegularFile(item)) throw this.options.labels.notFound(segments);
    return { item, parentId };
  }

  /** The folder holding `segments`' last name. */
  private async resolveParent(api: DriveApi, folderId: string, segments: readonly string[]): Promise<string> {
    let current = folderId;
    for (const name of segments.slice(0, -1)) {
      const item = await this.unique(api, current, name, segments);
      if (!isFolder(item)) throw this.options.labels.notFound(segments);
      current = item.id;
    }
    return current;
  }

  /** The one item named exactly `name` in the folder (not a shortcut). */
  private async unique(api: DriveApi, parentId: string, name: string, segments: readonly string[]): Promise<DriveItem> {
    const { labels } = this.options;
    const items = (
      await this.call(() => api.listChildren(parentId, { name }), `cannot read ${labels.quote(segments)}`)
    ).filter((item) => item.name === name);
    if (items.length === 0) throw labels.notFound(segments);
    if (items.length > 1) {
      throw new ConflictError(
        `${labels.quote(segments)} names several items in Google Drive, so none is used; rename or remove the duplicates in Google Drive`,
      );
    }
    const item = items[0]!;
    if (isShortcut(item)) {
      throw new InputValidationError(`${labels.quote(segments)} goes through a Google Drive shortcut, which is not supported`);
    }
    return item;
  }

  /** Items of the folder whose name equals `name` ignoring case and Unicode normalization (every page). */
  private async sameName(api: DriveApi, parentId: string, name: string, segments: readonly string[]): Promise<DriveItem[]> {
    const key = createKey(name);
    const children = await this.call(() => api.listChildren(parentId), `cannot check ${this.options.labels.quote(segments)}`);
    return children.filter((item) => createKey(item.name) === key);
  }

  private assertSize(bytes: number, segments: readonly string[]): void {
    if (bytes > MAX_DRIVE_FILE_BYTES) {
      throw new InputValidationError(
        `${this.options.labels.quote(segments)} would be larger than 5 MiB, the most AI Foundation writes to a file in Google Drive`,
      );
    }
  }

  /** Runs a Drive call, converting what it throws. */
  private async call<T>(run: () => Promise<T>, options: string | DriveErrorOptions): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toDriveError(error, typeof options === 'string' ? { context: options } : options);
    }
  }
}

function groupByName(items: readonly DriveItem[]): Map<string, DriveItem[]> {
  const groups = new Map<string, DriveItem[]>();
  for (const item of items) {
    const group = groups.get(item.name);
    if (group) group.push(item);
    else groups.set(item.name, [item]);
  }
  return groups;
}
