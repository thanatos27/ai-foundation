import type { DriveApi } from '../google-drive/client.js';
import { decodeLenient } from './decode.js';
import type { DriveCreateLock } from './drive-create-lock.js';
import { type DriveFileContent, DriveVaultDirectory } from './drive-vault-directory.js';
import { segmentsBelow, type VaultPath, vaultPathBelow } from './id.js';
import { knowledgeLabels } from './labels.js';
import type { VaultFile, VaultListEntry, VaultStorage } from './storage.js';

export interface DriveVaultStorageOptions {
  api: () => Promise<DriveApi>;
  /** `sources.knowledge.obsidian.vault_folder_id`. */
  vaultFolderId: string | undefined;
  /** `sources.knowledge.obsidian.knowledge_dir`: vault-relative, `/`-separated. */
  knowledgeDir: string | undefined;
  /** `sources.lifelog.obsidian.directory`: knowledge_dir must be apart from it (checked by folder ID). */
  lifeLogDir?: string | undefined;
  createLock: DriveCreateLock;
}

/**
 * Knowledge vault storage in Google Drive: knowledge_dir as a `DriveVaultDirectory`, with the same
 * knowledge IDs, messages and lenient decoding as `FilesystemVaultStorage`.
 */
export class DriveVaultStorage implements VaultStorage {
  private readonly directory: DriveVaultDirectory;

  constructor(private readonly options: DriveVaultStorageOptions) {
    this.directory = new DriveVaultDirectory({
      api: options.api,
      vaultFolderId: options.vaultFolderId,
      dir: options.knowledgeDir,
      labels: knowledgeLabels(options.knowledgeDir),
      createLock: options.createLock,
      apartFrom: [{ dir: options.lifeLogDir, dirName: 'life log directory' }],
    });
  }

  checkKnowledgeDir(): Promise<void> {
    return this.directory.check();
  }

  async list(): Promise<VaultListEntry[]> {
    const files = await this.directory.list();
    return files.map(({ segments, modifiedAt, read }) => {
      const path = vaultPathBelow(this.options.knowledgeDir!, segments);
      return { path, modifiedAt, read: async () => this.toFile(path, await read()) };
    });
  }

  async read(path: VaultPath): Promise<VaultFile> {
    return this.toFile(path, await this.directory.read(this.segments(path)));
  }

  createExclusive(path: VaultPath, text: string): Promise<void> {
    return this.directory.createExclusive(this.segments(path), text);
  }

  async append(path: VaultPath, compose: (file: VaultFile) => string): Promise<VaultFile> {
    let file: VaultFile | undefined;
    await this.directory.append(this.segments(path), (content) => compose((file = this.toFile(path, content))));
    return file!;
  }

  private toFile(path: VaultPath, { bytes, modifiedAt }: DriveFileContent): VaultFile {
    return { path, text: decodeLenient(bytes), modifiedAt };
  }

  /** `path` below knowledge_dir. While knowledge_dir is unset the directory throws before using them. */
  private segments(path: VaultPath): string[] {
    return segmentsBelow(path, this.options.knowledgeDir ?? '');
  }
}
