export interface LifeLogFile {
  /** File name directly in the life log directory, e.g. `2026-10-03-東京散策.md`. */
  name: string;
  /** UTF-8 text without a byte order mark. */
  text: string;
}

/**
 * How life log articles are stored (MVP: one directory of the Obsidian vault on the file system).
 * Everything that crosses this boundary is a file name in the life log directory, so another
 * storage (e.g. a Google Drive folder) can replace it without changing life log IDs.
 *
 * Every method first checks that the directory is usable (ConfigurationError otherwise) and never
 * reads or writes anything else. Nothing here truncates, renames or replaces an existing file.
 */
export interface LifeLogStorage {
  /** Where `name` is, for `external_ref` (vault-relative for Obsidian), without touching the storage. */
  refOf(name: string): string;
  /** NotFoundError when no regular file is there; ProviderApiError when it is not valid UTF-8. */
  read(name: string): Promise<LifeLogFile>;
  /** Creates the file; InputValidationError when anything already has that name. Never overwrites. */
  createExclusive(name: string, text: string): Promise<void>;
  /** Adds `text` to the end of the existing file and changes nothing else; NotFoundError when it is gone. */
  append(name: string, text: string): Promise<void>;
}
