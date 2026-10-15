import { describe, expect, it } from 'vitest';
import { invalidTag, tagKey, tagProblem } from '../../../src/connectors/obsidian/tags.js';

describe('tagProblem', () => {
  it.each(['ai', 'distributed-systems', 'snake_case', 'inbox/to-read', 'y1984', '1984y', '分散システム', '📚', 'CamelCase', '___'])(
    'accepts %j',
    (tag) => {
      expect(tagProblem(tag)).toBeUndefined();
    },
  );

  it.each([
    ['', /empty/],
    ['distributed systems', /spaces/],
    ['全角　空白', /spaces/],
    ['tab\there', /spaces/],
    ['#ai', /"#"/],
    ['a#b', /"#"/],
    ['c++', /letters, numbers/],
    ['a,b', /letters, numbers/],
    ['v1.0', /letters, numbers/],
    ['a:b', /letters, numbers/],
    ['[ai]', /letters, numbers/],
    ['1984', /non-numeric/],
    ['2024/10', /non-numeric/],
    ['/ai', /"\/"/],
    ['ai/', /"\/"/],
    ['ai//rag', /"\/"/],
  ])('rejects %j', (tag, reason) => {
    expect(tagProblem(tag)).toMatch(reason);
  });
});

describe('tagKey / invalidTag', () => {
  it('compares tags case-insensitively', () => {
    expect(tagKey('Distributed-Systems')).toBe(tagKey('distributed-systems'));
  });

  it('reports the first invalid tag', () => {
    expect(invalidTag(['ai', '1984', '#x'])).toEqual({ tag: '1984', problem: expect.stringMatching(/non-numeric/) });
    expect(invalidTag(['ai', 'rag'])).toBeUndefined();
  });
});
