import type { VaultPath } from './id.js';

export interface VaultFile {
  path: VaultPath;
  /** UTF-8 text without a byte order mark. */
  text: string;
  /** Last modification, in epoch milliseconds. */
  modifiedAt: number;
}

/**
 * How the Obsidian connector reaches the vault: the local file system or Google Drive. Everything
 * that crosses this boundary is vault-relative: absolute paths, OS separators, errno and Drive file
 * IDs stay inside the implementation, so either storage gives the same knowledge IDs.
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
  /**
   * Creates the file; ConflictError when anything already exists at `path`. Never overwrites.
   * Atomic on the file system. Google Drive has no atomic create by name: same-name files created at
   * the same time elsewhere can still leave duplicates, and a ConflictError found after creating
   * says the file was created (docs/specs/google-drive-storage.md).
   */
  createExclusive(path: VaultPath, text: string): Promise<void>;
  /**
   * Reads the file, then adds what `compose` returns for it to the end and changes nothing else.
   * The text is written against the very content `compose` was given: a storage that can tell
   * throws ConflictError, without writing, when the file changed in between. When `compose` throws
   * (e.g. malformed frontmatter), nothing is written. NotFoundError when the file is gone.
   * Returns the file as it was read.
   */
  append(path: VaultPath, compose: (file: VaultFile) => string): Promise<VaultFile>;
}
