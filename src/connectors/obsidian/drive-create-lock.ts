/** The name as creates compare it: Unicode NFC, lower case (as Windows / macOS sync folders would). */
export function createKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Runs creates of the same name in the same Drive folder one at a time, within this process only.
 * It orders the checks and the create; it does not make names unique: other processes, other
 * clients and a listing that lags behind a create are not covered (docs/specs/google-drive-storage.md).
 * Different keys run in parallel. One instance is shared by the knowledge and life log storages.
 */
export class DriveCreateLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(parentId: string, name: string, task: () => Promise<T>): Promise<T> {
    const key = `${parentId}\u0000${createKey(name)}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => done);
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys with a create running or waiting (for tests). */
  get size(): number {
    return this.tails.size;
  }
}
