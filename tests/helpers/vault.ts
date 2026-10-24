import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const KNOWLEDGE_DIR = 'AI Foundation/Knowledge';
export const LIFELOG_DIR = 'AI Foundation/LifeLog';

/**
 * A throwaway vault in the OS temp directory (never the user's vault), with a sibling `outside`
 * directory for boundary tests:
 *
 *   <base>/vault/AI Foundation/Knowledge/
 *   <base>/vault/AI Foundation/LifeLog/
 *   <base>/outside/
 */
export interface TestVault {
  base: string;
  vault: string;
  outside: string;
  /** Writes a file at a vault-relative path, creating directories. */
  write(path: string, text: string): Promise<void>;
  read(path: string): Promise<string>;
  /** Absolute path of a vault-relative path. */
  abs(path: string): string;
  /** Strings that must not appear in any error message (absolute paths of the temp directories). */
  secrets: string[];
  cleanup(): Promise<void>;
}

export async function createTestVault(): Promise<TestVault> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'af-vault-')));
  const vault = join(base, 'vault');
  const outside = join(base, 'outside');
  await mkdir(join(vault, ...KNOWLEDGE_DIR.split('/')), { recursive: true });
  await mkdir(join(vault, ...LIFELOG_DIR.split('/')), { recursive: true });
  await mkdir(outside, { recursive: true });
  const abs = (path: string) => join(vault, ...path.split('/'));
  return {
    base,
    vault,
    outside,
    abs,
    async write(path, text) {
      await mkdir(dirname(abs(path)), { recursive: true });
      await writeFile(abs(path), text, 'utf8');
    },
    read: (path) => readFile(abs(path), 'utf8'),
    secrets: [base, base.replaceAll('\\', '/'), tmpdir()],
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/** Directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
export async function linkDirectory(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, 'junction');
}

/** File symlink. Returns false where the OS does not let this user create one (Windows without Developer Mode). */
export async function linkFile(target: string, path: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

/** Whether file symlinks can be created here (decided once, for `it.skipIf`). */
export async function canLinkFiles(): Promise<boolean> {
  const vault = await createTestVault();
  try {
    await writeFile(join(vault.outside, 't'), '');
    return await linkFile(join(vault.outside, 't'), join(vault.base, 'l'));
  } finally {
    await vault.cleanup();
  }
}
