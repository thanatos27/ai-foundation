import { describe, expect, it } from 'vitest';
import { hasAttendedFlag } from '../../../src/connectors/google-calendar/attendance.js';

describe('hasAttendedFlag', () => {
  it.each([
    ['alone', '#attended'],
    ['followed by a newline', '#attended\n'],
    ['after a newline', '\n#attended'],
    ['surrounded by spaces', '  #attended  '],
    ['at the end of a sentence', '参加しました #attended'],
    ['at the start of a line', '#attended 楽しかった'],
    ['on its own line', 'メモ\n#attended\n詳細'],
    ['after a full stop', '参加。#attended'],
    ['before a full stop', '#attended。'],
    ['in parentheses', '(#attended)'],
    ['in brackets', '「#attended」'],
    ['before an exclamation mark', '#attended!'],
    ['in emphasis marks', '**#attended**'],
    ['after a no-break space', 'メモ #attended'],
    ['in bold', '<b>#attended</b>'],
    ['in a paragraph', '<p>#attended</p>'],
    ['after a line break tag', 'メモ<br>#attended'],
    ['between self-closing line breaks', '参加<br/>#attended<br>'],
    ['after a letter across a tag boundary', '参加<b>#attended</b>'],
    ['as link text', '<a href="https://example.com">#attended</a>'],
    ['after an entity', '&nbsp;#attended'],
    ['before an entity', '#attended&nbsp;'],
    ['next to a non-flag', '#attended #attended2'],
  ])('detects the flag %s', (_label, description) => {
    expect(hasAttendedFlag(description)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['no tag', '参加しました'],
    ['a digit suffix', '#attended2'],
    ['a hyphen suffix', '#attended-other'],
    ['an underscore suffix', '#attended_x'],
    ['a letter suffix', '#attendedです'],
    ['a full-width digit suffix', '#attended２'],
    ['capitalized', '#Attended'],
    ['upper case', '#ATTENDED'],
    ['mixed case', '#attendeD'],
    ['a full-width hash', '＃attended'],
    ['full-width letters', '#ａｔｔｅｎｄｅｄ'],
    ['an encoded hash', '&#35;attended'],
    ['no hash', 'attended'],
    ['a space after the hash', '# attended'],
    ['a double hash', '##attended'],
    ['a preceding Latin letter', 'x#attended'],
    ['a preceding Japanese letter', '参加#attended'],
    ['a preceding hyphen', 'foo-#attended'],
    ['a preceding underscore', 'a_#attended'],
    ['a URL fragment after a slash', 'https://example.com/#attended'],
    ['a URL fragment after a letter', 'https://example.com/page#attended'],
    ['a link target', '<a href="https://example.com/#attended">資料</a>'],
    ['an attribute value', '<span title="#attended">x</span>'],
    ['a double-quoted attribute value containing ">"', '<span title="a > #attended">資料</span>'],
    ['a single-quoted attribute value containing ">"', "<span title='a > #attended'>資料</span>"],
    ['an attribute value containing the other quote and ">"', `<span title="it's > #attended">x</span>`],
    ['an attribute value containing "<" and ">"', '<span title="a < b > #attended">x</span>'],
    ['an HTML comment', '<!-- #attended -->'],
  ])('ignores %s', (_label, description) => {
    expect(hasAttendedFlag(description)).toBe(false);
  });

  // Known limits of the lightweight markup handling (docs/specs/schedule-attendance.md).
  it.each([
    ['an unterminated comment is text', '<!-- #attended', true],
    ['"<" followed by a letter starts a tag', 'x<y #attended>z', false],
    ['"<" followed by a space is text', 'a < b #attended', true],
    ['an unclosed quoted attribute is text', '<span title="a > #attended>x', true],
    ['a "<" that never closes does not swallow the next tag', 'x<y<b>#attended</b>', true],
  ])('%s', (_label, description, expected) => {
    expect(hasAttendedFlag(description)).toBe(expected);
  });

  it('stays fast on many unclosed tags', () => {
    const started = performance.now();
    expect(hasAttendedFlag(`${'<a "'.repeat(20_000)}`)).toBe(false);
    expect(hasAttendedFlag(`${'<a '.repeat(20_000)}#attended`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('gives the same answer on repeated calls', () => {
    expect([1, 2, 3].map(() => hasAttendedFlag('#attended'))).toEqual([true, true, true]);
  });
});
