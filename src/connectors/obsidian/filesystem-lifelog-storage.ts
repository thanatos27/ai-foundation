import { InputValidationError, NotFoundError, ProviderApiError } from '../../errors.js';
import { quoteLifeLogId } from './lifelog-id.js';
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
    const nameOf = (segments: readonly string[]) => segments.join('/');
    this.directory = new FilesystemVaultDirectory({
      vaultPath: options.vaultPath,
      dir: options.directory,
      labels: {
        dirConfigKey: 'sources.lifelog.obsidian.directory',
        dirName: 'life log directory',
        quote: (segments) => quoteLifeLogId(nameOf(segments)),
        notFound: (segments, cause) =>
          new NotFoundError(
            `life log ${quoteLifeLogId(nameOf(segments))} was not found; it may have been renamed, moved or deleted in Obsidian`,
            cause === undefined ? undefined : { cause },
          ),
        alreadyExists: (segments, cause) =>
          new InputValidationError(
            `life log ${quoteLifeLogId(nameOf(segments))} already exists; choose another title, or use lifelog_append to add to it`,
            { cause },
          ),
      },
      apartFrom: [{ dir: options.knowledgeDir, dirName: 'knowledge directory' }],
    });
  }

  refOf(name: string): string {
    return `${this.options.directory}/${name}`;
  }

  async read(name: string): Promise<LifeLogFile> {
    const { bytes } = await this.directory.read([name]);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new ProviderApiError('Obsidian', `life log ${quoteLifeLogId(name)} is not valid UTF-8; fix it in Obsidian`, {
        cause: error,
      });
    }
    return { name, text: text.replace(/^﻿/, '') };
  }

  createExclusive(name: string, text: string): Promise<void> {
    return this.directory.createExclusive([name], text);
  }

  append(name: string, text: string): Promise<void> {
    return this.directory.append([name], text);
  }
}
