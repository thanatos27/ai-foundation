import { describe, expect, it } from 'vitest';
import { createKey, DriveCreateLock } from '../../../src/connectors/obsidian/drive-create-lock.js';

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('createKey', () => {
  it('ignores case and Unicode normalization', () => {
    expect(createKey('café.md')).toBe(createKey('Café.md')); // NFD vs NFC, and case
    expect(createKey('が.md')).toBe(createKey('が.md'));
    expect(createKey('Tokyo.md')).toBe(createKey('tokyo.md'));
    expect(createKey('a.md')).not.toBe(createKey('b.md'));
  });
});

describe('DriveCreateLock', () => {
  it('runs tasks of the same key one at a time, in order', async () => {
    const lock = new DriveCreateLock();
    const events: string[] = [];
    const first = gate();
    const a = lock.run('folder', 'Note.md', async () => {
      events.push('a start');
      await first.opened;
      events.push('a end');
      return 'a';
    });
    // Same key under another case and normalization.
    const b = lock.run('folder', 'note.md', async () => {
      events.push('b start');
      return 'b';
    });
    await Promise.resolve();
    expect(events).toEqual(['a start']);
    first.open();
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(events).toEqual(['a start', 'a end', 'b start']);
    expect(lock.size).toBe(0);
  });

  it('runs different names, or the same name in different folders, in parallel', async () => {
    const lock = new DriveCreateLock();
    const held = gate();
    const started: string[] = [];
    const slow = lock.run('folder', 'a.md', async () => {
      started.push('a');
      await held.opened;
    });
    await lock.run('folder', 'b.md', async () => void started.push('b'));
    await lock.run('other', 'a.md', async () => void started.push('other a'));
    expect(started).toEqual(['a', 'b', 'other a']);
    held.open();
    await slow;
  });

  it('releases the key when a task throws', async () => {
    const lock = new DriveCreateLock();
    await expect(
      lock.run('folder', 'a.md', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(lock.run('folder', 'a.md', async () => 'next')).resolves.toBe('next');
    expect(lock.size).toBe(0);
  });
});
