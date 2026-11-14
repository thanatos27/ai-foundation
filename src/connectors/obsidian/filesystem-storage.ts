import { decodeLenient } from './decode.js';
import { segmentsBelow, type VaultPath, vaultPathBelow } from './id.js';
import { knowledgeLabels } from './labels.js';
import type { VaultFile, VaultListEntry, VaultStorage } from './storage.js';
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
    this.directory = new FilesystemVaultDirectory({
      vaultPath: options.vaultPath,
      dir: options.knowledgeDir,
      labels: knowledgeLabels(options.knowledgeDir),
      apartFrom: [{ dir: options.lifeLogDir, dirName: 'life log directory' }],
    });
  }

  checkKnowledgeDir(): Promise<void> {
    return this.directory.check();
  }

  async list(): Promise<VaultListEntry[]> {
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
