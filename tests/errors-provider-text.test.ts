import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A guard, not the proof: the conversions themselves are tested in
 * tests/connectors/provider-text.test.ts. It flags connector code that puts the message of an
 * error, or `String(error)`, into text without `providerText` / `errorText`, so that a new error
 * path does not send SDK text over the HTTP API unnoticed.
 */
const connectorsDir = fileURLToPath(new URL('../src/connectors', import.meta.url));

const SUSPICIOUS = /\.message\b|String\(error\)|\$\{message\}/;
const WRAPPED = /providerText\(|errorText\(/;

/** Lines that match but carry no provider text into a message, with the reason. */
const ALLOWED = new Map<string, string>([
  // Only read here; Google Calendar and Google Drive pass it on through providerText(message).
  ['google/errors.ts', 'const message = e.message ?? String(error);'],
  // Notion SDK log lines go to stderr, never into an error.
  ['notion/client.ts', 'console.error(`[ai-foundation] Notion ${level}: ${message}`, extraInfo);'],
  // `message` is a parameter AI Foundation writes (e.g. "cannot read ..."); only the errno code is added.
  ['obsidian/vault-directory.ts', "return new ProviderApiError('Obsidian', `${message} (${errnoOf(error) ?? 'filesystem error'})`, { cause: error });"],
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts')).map((entry) => join(entry.parentPath, entry.name));
}

describe('provider text in connector errors', () => {
  it('goes through providerText or errorText', async () => {
    const offending: string[] = [];
    for (const file of await sourceFiles(connectorsDir)) {
      const name = relative(connectorsDir, file).replaceAll('\\', '/');
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (!SUSPICIOUS.test(code) || WRAPPED.test(code)) return;
        if ([...ALLOWED].some(([allowedFile, allowedLine]) => allowedFile === name && allowedLine === code)) return;
        offending.push(`${name}:${index + 1}: ${code}`);
      });
    }
    expect(offending).toEqual([]);
  });

  it('still has every allowed line, so the list does not go stale', async () => {
    for (const [file, line] of ALLOWED) {
      const text = await readFile(join(connectorsDir, file), 'utf8');
      expect(text.split('\n').map((l) => l.trim())).toContain(line);
    }
  });
});
