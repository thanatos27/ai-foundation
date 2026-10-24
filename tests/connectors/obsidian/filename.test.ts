import { describe, expect, it } from 'vitest';
import { sanitizeFileTitle, toFileName } from '../../../src/connectors/obsidian/filename.js';
import { InputValidationError } from '../../../src/errors.js';

describe('toFileName', () => {
  it.each([
    ['CAP定理', 'CAP定理.md'],
    ['RAG: 構成と役割', 'RAG 構成と役割.md'],
    ['A/B テスト', 'A B テスト.md'],
    ['[[リンク]] #tag', 'リンク tag.md'],
    ['.env の扱い', 'env の扱い.md'],
    ['what? why*', 'what why.md'],
    ['a\\b|c<d>"e"', 'a b c d e.md'],
    ['二行の\nタイトル\tです', '二行の タイトル です.md'],
    ['全角　空白', '全角 空白.md'],
    ['  trimmed  ', 'trimmed.md'],
    ['ends with dot.', 'ends with dot.md'],
    ['. . .leading', 'leading.md'],
    ['a^b', 'a b.md'],
    ['ctrl\u0007char', 'ctrl char.md'],
    ['CONSOLE', 'CONSOLE.md'],
    ['📚 読書メモ', '📚 読書メモ.md'],
  ])('%j → %j', (title, expected) => {
    expect(toFileName(title)).toBe(expected);
  });

  it.each(['???', '...', ' : / ', '#[]^'])('rejects a title with nothing usable: %j', (title) => {
    expect(() => toFileName(title)).toThrow(InputValidationError);
  });

  it.each(['CON', 'con', 'Nul', 'COM1', 'lpt9', 'aux.txt', 'PRN.md'])('rejects the Windows reserved name %j', (title) => {
    expect(() => toFileName(title)).toThrow(/reserved/);
  });

  it('accepts names up to 200 UTF-8 bytes and rejects longer ones', () => {
    // 66 × 3 bytes + 2 = 200 bytes
    expect(toFileName(`${'あ'.repeat(66)}ab`)).toBe(`${'あ'.repeat(66)}ab.md`);
    expect(() => toFileName(`${'あ'.repeat(66)}abc`)).toThrow(/too long/);
    expect(toFileName('a'.repeat(200))).toBe(`${'a'.repeat(200)}.md`);
    expect(() => toFileName('a'.repeat(201))).toThrow(/too long/);
  });
});

describe('sanitizeFileTitle', () => {
  it('is the title part of toFileName, without the extension or the Windows / length checks', () => {
    expect(sanitizeFileTitle('RAG: 構成と役割')).toBe('RAG 構成と役割');
    expect(sanitizeFileTitle('  [[リンク]] #tag. ')).toBe('リンク tag');
    expect(sanitizeFileTitle('CON')).toBe('CON');
    expect(sanitizeFileTitle('a'.repeat(300))).toBe('a'.repeat(300));
  });

  it('rejects a title with nothing usable, with the same message as toFileName', () => {
    expect(() => sanitizeFileTitle(' : / ')).toThrow(InputValidationError);
    expect(() => sanitizeFileTitle(' : / ')).toThrow('title " : / " cannot be turned into a file name');
  });
});
