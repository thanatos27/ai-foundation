import { describe, expect, it } from 'vitest';
import { canMatch, toQueryFilter } from '../../../src/connectors/notion/filter.js';

describe('toQueryFilter', () => {
  it('returns no filter for an empty search', () => {
    expect(toQueryFilter({})).toBeUndefined();
  });

  it.each([
    [{ query: 'ペルソナ' }, [{ property: 'Name', title: { contains: 'ペルソナ' } }]],
    [{ collection_type: 'book' as const }, [{ property: 'Type', select: { equals: 'book' } }]],
    [{ status: 'reading' }, [{ property: 'Status', select: { equals: 'reading' } }]],
    [
      { tags: ['分散システム', 'DB'] },
      [
        { property: 'Tags', multi_select: { contains: '分散システム' } },
        { property: 'Tags', multi_select: { contains: 'DB' } },
      ],
    ],
  ])('maps %j', (filter, conditions) => {
    expect(toQueryFilter(filter)).toEqual({ and: conditions });
  });

  it('combines every filter with AND', () => {
    expect(toQueryFilter({ query: 'a', collection_type: 'game', status: 'playing', tags: ['RPG'] })).toEqual({
      and: [
        { property: 'Name', title: { contains: 'a' } },
        { property: 'Type', select: { equals: 'game' } },
        { property: 'Status', select: { equals: 'playing' } },
        { property: 'Tags', multi_select: { contains: 'RPG' } },
      ],
    });
  });
});

describe('canMatch', () => {
  it.each([
    [{}, true],
    [{ status: 'reading', tags: ['RPG'] }, true],
    [{ query: 'a, b' }, true],
    [{ status: 'a,b' }, false],
    [{ tags: ['RPG', 'a,b'] }, false],
  ])('%j → %s', (filter, expected) => {
    expect(canMatch(filter)).toBe(expected);
  });
});
