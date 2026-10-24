import { describe, expect, it } from 'vitest';
import { appendText as appendFromMarkdown } from '../../../src/connectors/obsidian/markdown.js';
import { appendText, normalizeBody } from '../../../src/connectors/obsidian/text.js';

describe('normalizeBody', () => {
  it.each([
    ['a', 'a\n'],
    ['a\n', 'a\n'],
    ['a\n\n', 'a\n\n'],
    ['a\r\nb\rc', 'a\nb\nc\n'],
    ['  # 見出し  ', '  # 見出し  \n'],
    ['😀 絵文字', '😀 絵文字\n'],
  ])('%j → %j', (content, expected) => {
    expect(normalizeBody(content)).toBe(expected);
  });
});

describe('appendText', () => {
  it('is the same function knowledge imports from markdown.ts', () => {
    expect(appendFromMarkdown).toBe(appendText);
  });

  it('starts a new paragraph in the file line ending', () => {
    expect(appendText('', 'x')).toBe('x\n');
    expect(appendText('a', 'x')).toBe('\n\nx\n');
    expect(appendText('a\n\n', 'x')).toBe('x\n');
    expect(appendText('a\r\n', 'x\ny')).toBe('\r\nx\r\ny\r\n');
  });
});
