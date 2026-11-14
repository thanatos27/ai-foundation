import { ConflictError, NotFoundError } from '../../errors.js';
import { decodeLenient } from './decode.js';
import { quoteId, segmentsBelow, type VaultPath, vaultPathBelow } from './id.js';
import type { VaultFile, VaultStorage } from './storage.js';
import { FilesystemVaultDirectory } from './vault-directory.js';

export interface FilesystemVaultStorageOptions {
  /** `sources.knowledge.obsidian.vault_path`: absolute path of the vault. */
  vaultPath: string | undefined;
  /** `sources.knowledge.obsidian.knowledge_dir`: vault-relative, `/`-separated. */
  knowledgeDir: string | undefined;
  /** `sources.lifelog.obsidian.directory`: knowledge_dir must be apart from it (checked by real path). */
  lifeLogDir?: string | undefined;
}

/**
 * Knowledge vault storage on the local file system: knowledge_dir as a `FilesystemVaultDirectory`
 * (which holds the boundary rules), with knowledge IDs in its messages.
 *
 * Text is decoded leniently, as Phase 4 did: bytes that are not UTF-8 become U+FFFD instead of an error.
 */
export class FilesystemVaultStorage implements VaultStorage {
  private readonly directory: FilesystemVaultDirectory;

  constructor(private readonly options: FilesystemVaultStorageOptions) {
    const pathOf = (segments: readonly string[]) => vaultPathBelow(options.knowledgeDir ?? '', [...segments]);
    this.directory = new FilesystemVaultDirectory({
      vaultPath: options.vaultPath,
      dir: options.knowledgeDir,
      labels: {
        dirConfigKey: 'sources.knowledge.obsidian.knowledge_dir',
        dirName: 'knowledge directory',
        quote: (segments) => quoteId(pathOf(segments)),
        notFound: (segments, cause) => notFound(pathOf(segments), cause),
        alreadyExists: (segments, cause) =>
          new ConflictError(
            `knowledge ${quoteId(pathOf(segments))} already exists; use knowledge_search and knowledge_append to add to it`,
            { cause },
          ),
      },
      apartFrom: [{ dir: options.lifeLogDir, dirName: 'life log directory' }],
    });
  }

  checkKnowledgeDir(): Promise<void> {
    return this.directory.check();
  }

  async list(): Promise<{ path: VaultPath; modifiedAt: number }[]> {
    const files = await this.directory.list();
    return files.map(({ segments, modifiedAt }) => ({
      path: vaultPathBelow(this.options.knowledgeDir!, segments),
      modifiedAt,
    }));
  }

  async read(path: VaultPath): Promise<VaultFile> {
    const { bytes, modifiedAt } = await this.directory.read(this.segments(path));
    return { path, text: decodeLenient(bytes), modifiedAt };
  }

  createExclusive(path: VaultPath, text: string): Promise<void> {
    return this.directory.createExclusive(this.segments(path), text);
  }

  /**
   * Read, compose, then O_APPEND: the write lands at the current end of the file, so text another
   * program appended in between is kept (the file system cannot tell it changed).
   */
  async append(path: VaultPath, compose: (file: VaultFile) => string): Promise<VaultFile> {
    const file = await this.read(path);
    await this.directory.append(this.segments(path), compose(file));
    return file;
  }

  /** `path` below knowledge_dir. While knowledge_dir is unset the directory throws before using them. */
  private segments(path: VaultPath): string[] {
    return segmentsBelow(path, this.options.knowledgeDir ?? '');
  }
}

function notFound(path: VaultPath, cause?: unknown): NotFoundError {
  return new NotFoundError(
    `knowledge ${quoteId(path)} was not found; it may have been moved or deleted — search again with knowledge_search`,
    cause === undefined ? undefined : { cause },
  );
}
