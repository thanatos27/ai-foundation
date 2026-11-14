import { decodeStrict } from './decode.js';
import { lifeLogLabels, notUtf8 } from './labels.js';
import type { LifeLogFile, LifeLogStorage } from './lifelog-storage.js';
import { FilesystemVaultDirectory } from './vault-directory.js';

export interface FilesystemLifeLogStorageOptions {
  /** `sources.knowledge.obsidian.vault_path`: life logs live in the knowledge vault. */
  vaultPath: string | undefined;
  /** `sources.lifelog.obsidian.directory`: vault-relative, `/`-separated. */
  directory: string | undefined;
  /** `sources.knowledge.obsidian.knowledge_dir`: the directory must be apart from it (checked by real path). */
  knowledgeDir?: string | undefined;
}

/**
 * Life log storage on the local file system: the life log directory as a `FilesystemVaultDirectory`
 * (the same boundary rules as knowledge), holding only files directly in it.
 *
 * Unlike knowledge, text is decoded strictly: a file that is not valid UTF-8 is an error, so it is
 * neither shown with replacement characters nor appended to.
 */
export class FilesystemLifeLogStorage implements LifeLogStorage {
  private readonly directory: FilesystemVaultDirectory;

  constructor(private readonly options: FilesystemLifeLogStorageOptions) {
    this.directory = new FilesystemVaultDirectory({
      vaultPath: options.vaultPath,
      dir: options.directory,
      labels: lifeLogLabels(),
      apartFrom: [{ dir: options.knowledgeDir, dirName: 'knowledge directory' }],
    });
  }

  refOf(name: string): string {
    return `${this.options.directory}/${name}`;
  }

  async read(name: string): Promise<LifeLogFile> {
    const { bytes } = await this.directory.read([name]);
    return { name, text: decodeStrict(bytes, (cause) => notUtf8('Obsidian', name, cause)) };
  }

  createExclusive(name: string, text: string): Promise<void> {
    return this.directory.createExclusive([name], text);
  }

  /** Read (strictly), compose, then O_APPEND, as for knowledge (`FilesystemVaultStorage.append`). */
  async append(name: string, compose: (file: LifeLogFile) => string): Promise<LifeLogFile> {
    const file = await this.read(name);
    await this.directory.append([name], compose(file));
    return file;
  }
}
