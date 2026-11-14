import { ConflictError, NotFoundError, ProviderApiError } from '../../errors.js';
import { quoteId, vaultPathBelow } from './id.js';
import { quoteLifeLogId } from './lifelog-id.js';
import type { VaultDirectoryLabels } from './vault-directory.js';

/**
 * What the knowledge and life log directories are called in errors, the same for every storage
 * (file system, Google Drive): messages name Foundation IDs, never an OS path or a Drive file ID.
 */

export function knowledgeLabels(knowledgeDir: string | undefined): VaultDirectoryLabels {
  const pathOf = (segments: readonly string[]) => vaultPathBelow(knowledgeDir ?? '', [...segments]);
  return {
    dirConfigKey: 'sources.knowledge.obsidian.knowledge_dir',
    dirName: 'knowledge directory',
    quote: (segments) => quoteId(pathOf(segments)),
    notFound: (segments, cause) =>
      new NotFoundError(
        `knowledge ${quoteId(pathOf(segments))} was not found; it may have been moved or deleted — search again with knowledge_search`,
        cause === undefined ? undefined : { cause },
      ),
    alreadyExists: (segments, cause) =>
      new ConflictError(
        `knowledge ${quoteId(pathOf(segments))} already exists; use knowledge_search and knowledge_append to add to it`,
        { cause },
      ),
  };
}

export function lifeLogLabels(): VaultDirectoryLabels {
  const nameOf = (segments: readonly string[]) => segments.join('/');
  return {
    dirConfigKey: 'sources.lifelog.obsidian.directory',
    dirName: 'life log directory',
    quote: (segments) => quoteLifeLogId(nameOf(segments)),
    notFound: (segments, cause) =>
      new NotFoundError(
        `life log ${quoteLifeLogId(nameOf(segments))} was not found; it may have been renamed, moved or deleted in Obsidian`,
        cause === undefined ? undefined : { cause },
      ),
    alreadyExists: (segments, cause) =>
      new ConflictError(
        `life log ${quoteLifeLogId(nameOf(segments))} already exists; choose another title, or use lifelog_append to add to it`,
        { cause },
      ),
  };
}

/** The error for a life log that is not valid UTF-8: it is neither shown nor appended to. */
export function notUtf8(provider: string, name: string, cause: unknown): ProviderApiError {
  return new ProviderApiError(provider, `life log ${quoteLifeLogId(name)} is not valid UTF-8; fix it in Obsidian`, {
    cause,
  });
}
