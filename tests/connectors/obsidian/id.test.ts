import { describe, expect, it } from 'vitest';
import {
  fileTitle,
  formatKnowledgeId,
  parseKnowledgeId,
  segmentsBelow,
  type VaultPath,
} from '../../../src/connectors/obsidian/id.js';
import { InputValidationError } from '../../../src/errors.js';

const DIR = 'AI Foundation/Knowledge';

describe('parseKnowledgeId', () => {
  it.each([
    'obsidian:AI Foundation/Knowledge/CAP定理.md',
    'obsidian:AI Foundation/Knowledge/AI/RAG.md',
    'obsidian:AI Foundation/Knowledge/Finance/深い/階層/リスク中立確率.md',
    'obsidian:AI Foundation/Knowledge/.archive/old.md',
    'obsidian:AI Foundation/Knowledge/.hidden.md',
  ])('accepts %s', (id) => {
    const path = parseKnowledgeId(id, DIR);
    expect(formatKnowledgeId(path)).toBe(id);
  });

  it.each([
    ['another provider', 'notion:abc'],
    ['no prefix', 'AI Foundation/Knowledge/a.md'],
    ['an empty path', 'obsidian:'],
    ['a control character', 'obsidian:AI Foundation/Knowledge/a\u0000.md'],
    ['backslashes', 'obsidian:AI Foundation\\Knowledge\\a.md'],
    ['a POSIX absolute path', 'obsidian:/etc/AI Foundation/Knowledge/a.md'],
    ['a drive letter', 'obsidian:C:/Users/me/AI Foundation/Knowledge/a.md'],
    ['a UNC path', 'obsidian://server/share/a.md'],
    ['..', 'obsidian:AI Foundation/Knowledge/../secret.md'],
    ['.. that returns inside', 'obsidian:AI Foundation/Knowledge/AI/../a.md'],
    ['.', 'obsidian:AI Foundation/Knowledge/./a.md'],
    ['an empty segment', 'obsidian:AI Foundation/Knowledge//a.md'],
    ['a non-Markdown file', 'obsidian:AI Foundation/Knowledge/a.txt'],
    ['an upper-case extension', 'obsidian:AI Foundation/Knowledge/a.MD'],
    ['only an extension', 'obsidian:AI Foundation/Knowledge/.md'],
    ['the knowledge directory itself', 'obsidian:AI Foundation/Knowledge.md'],
    ['another vault directory', 'obsidian:Daily/2026-10-15.md'],
    ['a directory sharing a prefix', 'obsidian:AI Foundation/Knowledge2/a.md'],
    ['a parent directory', 'obsidian:AI Foundation/a.md'],
  ])('rejects %s', (_label, id) => {
    expect(() => parseKnowledgeId(id, DIR)).toThrow(InputValidationError);
  });

  it('shortens very long ids in the message', () => {
    const id = `obsidian:${'x'.repeat(1000)}`;
    expect(() => parseKnowledgeId(id, DIR)).toThrow(/"obsidian:x{191}…"/);
  });
});

describe('path helpers', () => {
  const path = 'AI Foundation/Knowledge/AI/RAG.md' as VaultPath;

  it('derives the title of a note without frontmatter from its file name', () => {
    expect(fileTitle(path)).toBe('RAG');
    expect(fileTitle('K/CAP定理.md' as VaultPath)).toBe('CAP定理');
  });

  it('splits the segments below the knowledge directory', () => {
    expect(segmentsBelow(path, DIR)).toEqual(['AI', 'RAG.md']);
  });
});
