import { describe, expect, it } from 'vitest';
import {
  formatLifeLogId,
  lifeLogFileName,
  parseLifeLogFileName,
  parseLifeLogId,
  quoteLifeLogId,
} from '../../../src/connectors/obsidian/lifelog-id.js';
import { InputValidationError } from '../../../src/errors.js';

describe('lifeLogFileName', () => {
  it.each([
    ['2026-10-03', '東京散策', '2026-10-03-東京散策.md'],
    ['2026-10-18', 'EVE Online開始', '2026-10-18-EVE Online開始.md'],
    ['2026-10-03', '東京:散策', '2026-10-03-東京 散策.md'],
    ['2026-10-03', 'A/B\\C', '2026-10-03-A B C.md'],
    ['2026-10-03', '[[リンク]] #tag ^x', '2026-10-03-リンク tag x.md'],
    ['2026-10-03', '  .隠し. ', '2026-10-03-隠し.md'],
    ['2026-10-03', '改行\nタブ\t', '2026-10-03-改行 タブ.md'],
    ['2026-10-03', 'CON', '2026-10-03-CON.md'],
    ['2026-10-03', '📷 写真', '2026-10-03-📷 写真.md'],
  ])('%s + %j → %j', (date, title, expected) => {
    expect(lifeLogFileName(date, title)).toBe(expected);
  });

  it.each(['???', ' : / ', '#[]^', '...'])('rejects a title with nothing usable: %j', (title) => {
    expect(() => lifeLogFileName('2026-10-03', title)).toThrow(InputValidationError);
  });

  it('limits the name without ".md" to 200 UTF-8 bytes, the date included', () => {
    // "2026-10-03-" is 11 bytes: 11 + 63 × 3 = 200.
    expect(lifeLogFileName('2026-10-03', 'あ'.repeat(63))).toBe(`2026-10-03-${'あ'.repeat(63)}.md`);
    expect(() => lifeLogFileName('2026-10-03', `${'あ'.repeat(63)}a`)).toThrow(/too long/);
    expect(lifeLogFileName('2026-10-03', 'a'.repeat(189))).toBe(`2026-10-03-${'a'.repeat(189)}.md`);
    expect(() => lifeLogFileName('2026-10-03', 'a'.repeat(190))).toThrow(/too long/);
  });

  it('reads back as the same date and the sanitized title', () => {
    expect(parseLifeLogFileName(lifeLogFileName('2026-10-03', '東京:散策'))).toEqual({
      date: '2026-10-03',
      title: '東京 散策',
    });
  });
});

describe('parseLifeLogFileName', () => {
  it.each([
    ['2026-10-03-東京散策.md', { date: '2026-10-03', title: '東京散策' }],
    ['2028-02-29-閏日.md', { date: '2028-02-29', title: '閏日' }],
    ['2026-10-03-2026-10-04-連泊.md', { date: '2026-10-03', title: '2026-10-04-連泊' }],
    ['2026-10-03-a.b.md', { date: '2026-10-03', title: 'a.b' }],
    ['2026-10-03-#手動.md', { date: '2026-10-03', title: '#手動' }],
  ])('%j → %j', (name, expected) => {
    expect(parseLifeLogFileName(name)).toEqual(expected);
  });

  it.each([
    '東京散策.md',
    '2026-10-03.md',
    '2026-10-03-.md',
    '2026-10-3-東京.md',
    '2026-02-29-東京.md',
    '2026-13-01-東京.md',
    '2026-10-03-東京.MD',
    '2026-10-03-東京.txt',
    '2026-10-03-東京.md.bak',
    '2026-10-03_東京.md',
    '..',
    '2026-10-03-a/b.md',
    '2026-10-03-改行\n.md',
  ])('rejects %j', (name) => {
    expect(parseLifeLogFileName(name)).toBeUndefined();
  });
});

describe('parseLifeLogId', () => {
  it('returns the file name of a valid id', () => {
    expect(parseLifeLogId('lifelog:2026-10-03-東京散策.md')).toBe('2026-10-03-東京散策.md');
    expect(formatLifeLogId('2026-10-03-東京散策.md')).toBe('lifelog:2026-10-03-東京散策.md');
    expect(quoteLifeLogId('2026-10-03-東京散策.md')).toBe('"lifelog:2026-10-03-東京散策.md"');
  });

  it.each([
    ['obsidian:AI Foundation/Knowledge/2026-10-03-x.md', /must start with "lifelog:"/],
    ['2026-10-03-東京散策.md', /must start with "lifelog:"/],
    ['LIFELOG:2026-10-03-東京散策.md', /must start with "lifelog:"/],
    ['lifelog:', /has no file name/],
    ['lifelog:2026-10-03-a\u0000.md', /control characters/],
    ['lifelog:2026/2026-10-03-東京散策.md', /directly in the life log directory/],
    ['lifelog:../2026-10-03-x.md', /directly in the life log directory/],
    ['lifelog:..\\2026-10-03-x.md', /directly in the life log directory/],
    ['lifelog:/2026-10-03-x.md', /directly in the life log directory/],
    ['lifelog:C:/2026-10-03-x.md', /directly in the life log directory/],
    ['lifelog:AI Foundation/Knowledge/2026-10-03-x.md', /directly in the life log directory/],
    ['lifelog:..', /YYYY-MM-DD-<title>\.md/],
    ['lifelog:東京散策.md', /YYYY-MM-DD-<title>\.md/],
    ['lifelog:2026-02-30-x.md', /YYYY-MM-DD-<title>\.md/],
    ['lifelog:2026-10-03-x.txt', /YYYY-MM-DD-<title>\.md/],
  ])('rejects %j', (id, message) => {
    expect(() => parseLifeLogId(id)).toThrow(InputValidationError);
    expect(() => parseLifeLogId(id)).toThrow(message);
  });

  it('points to lifelog_create and the file name in its message, and shortens long ids', () => {
    const long = `lifelog:${'x'.repeat(500)}`;
    let message = '';
    try {
      parseLifeLogId(long);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('lifelog_create');
    expect(message).toContain('…');
    expect(message).not.toContain('x'.repeat(250));
  });
});
