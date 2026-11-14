import type { DriveApi } from '../google-drive/client.js';
import { decodeStrict } from './decode.js';
import type { DriveCreateLock } from './drive-create-lock.js';
import { type DriveFileContent, DriveVaultDirectory } from './drive-vault-directory.js';
import { lifeLogLabels, notUtf8 } from './labels.js';
import type { LifeLogFile, LifeLogStorage } from './lifelog-storage.js';

export interface DriveLifeLogStorageOptions {
  api: () => Promise<DriveApi>;
  /** `sources.knowledge.obsidian.vault_folder_id`: life logs live in the knowledge vault. */
  vaultFolderId: string | undefined;
  /** `sources.lifelog.obsidian.directory`: vault-relative, `/`-separated. */
  directory: string | undefined;
  /** `sources.knowledge.obsidian.knowledge_dir`: the directory must be apart from it (checked by folder ID). */
  knowledgeDir?: string | undefined;
  createLock: DriveCreateLock;
}

/**
 * Life log storage in Google Drive: the life log folder as a `DriveVaultDirectory`, holding only
 * files directly in it, with the same IDs, messages and strict decoding as `FilesystemLifeLogStorage`.
 */
export class DriveLifeLogStorage implements LifeLogStorage {
  private readonly directory: DriveVaultDirectory;

  constructor(private readonly options: DriveLifeLogStorageOptions) {
    this.directory = new DriveVaultDirectory({
      api: options.api,
      vaultFolderId: options.vaultFolderId,
      dir: options.directory,
      labels: lifeLogLabels(),
      createLock: options.createLock,
      apartFrom: [{ dir: options.knowledgeDir, dirName: 'knowledge directory' }],
    });
  }

  refOf(name: string): string {
    return `${this.options.directory}/${name}`;
  }

  async read(name: string): Promise<LifeLogFile> {
    return this.toFile(name, await this.directory.read([name]));
  }

  createExclusive(name: string, text: string): Promise<void> {
    return this.directory.createExclusive([name], text);
  }

  async append(name: string, compose: (file: LifeLogFile) => string): Promise<LifeLogFile> {
    let file: LifeLogFile | undefined;
    // Decoded before composing: a file that is not valid UTF-8 throws here and is never written to.
    await this.directory.append([name], (content) => compose((file = this.toFile(name, content))));
    return file!;
  }

  private toFile(name: string, { bytes }: DriveFileContent): LifeLogFile {
    return { name, text: decodeStrict(bytes, (cause) => notUtf8('Google Drive', name, cause)) };
  }
}
