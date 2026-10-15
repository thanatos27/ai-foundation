import type { VaultPath } from './id.js';

export interface VaultFile {
  path: VaultPath;
  /** UTF-8 text without a byte order mark. */
  text: string;
  /** Last modification, in epoch milliseconds. */
  modifiedAt: number;
}

/**
 * How the Obsidian connector reaches the vault (Phase 4: the local file system). Everything that
 * crosses this boundary is vault-relative: absolute paths, OS separators and errno stay inside the
 * implementation, so another storage (e.g. Google Drive) can replace it without changing knowledge IDs.
 *
 * Every method first checks that the vault and knowledge_dir are usable (ConfigurationError
 * otherwise) and never reads or writes outside knowledge_dir.
 */
export interface VaultStorage {
  /** Throws ConfigurationError when the vault or knowledge_dir is not usable. */
  checkKnowledgeDir(): Promise<void>;
  /** Every regular .md file under knowledge_dir, recursively, at any depth (links are not followed). */
  list(): Promise<{ path: VaultPath; modifiedAt: number }[]>;
  /** NotFoundError when nothing readable is at `path`. */
  read(path: VaultPath): Promise<VaultFile>;
  /** Creates the file; InputValidationError when anything already exists at `path`. Never overwrites. */
  createExclusive(path: VaultPath, text: string): Promise<void>;
  /** Adds `text` to the end of an existing file and changes nothing else; NotFoundError when it is gone. */
  append(path: VaultPath, text: string): Promise<void>;
}
