import { describe, expect, it } from 'vitest';
import type { KnowledgeMeta } from '../../../src/connectors/obsidian/markdown.js';
import { SNIPPET_LENGTH, matches, snippet } from '../../../src/connectors/obsidian/search.js';

const meta: KnowledgeMeta = {
  title: 'CAP定理',
  description: 'Distributed systems の基礎',
  area: 'personal',
  tags: ['database', 'Distributed-Systems'],
};
const body = 'CAP定理では一貫性・可用性・分断耐性のうち2つしか同時に満たせない。PACELCも参照。';

describe('matches', () => {
  it('matches everything with an empty filter', () => {
    expect(matches(meta, body, {})).toBe(true);
  });

  it.each([
    ['the title', 'cap'],
    ['the description', 'DISTRIBUTED SYSTEMS'],
    ['a tag', 'distributed-sys'],
    ['the body', 'pacelc'],
    ['Japanese in the body', '分断耐性'],
  ])('finds the query in %s, ignoring case', (_label, query) => {
    expect(matches(meta, body, { query })).toBe(true);
  });

  it('does not match a missing query', () => {
    expect(matches(meta, body, { query: 'raft' })).toBe(false);
  });

  it('does not search frontmatter keys it does not know (they are not in the body)', () => {
    expect(matches({ ...meta, description: null }, 'body', { query: 'aliases' })).toBe(false);
  });

  it('matches the area exactly, and null as no area', () => {
    expect(matches(meta, body, { area: 'personal' })).toBe(true);
    expect(matches(meta, body, { area: 'work' })).toBe(false);
    expect(matches(meta, body, { area: null })).toBe(false);
    expect(matches({ ...meta, area: null }, body, { area: null })).toBe(true);
  });

  it('requires every tag, ignoring case, without matching nested tag parents', () => {
    expect(matches(meta, body, { tags: ['distributed-systems'] })).toBe(true);
    expect(matches(meta, body, { tags: ['DATABASE', 'distributed-systems'] })).toBe(true);
    expect(matches(meta, body, { tags: ['database', 'ai'] })).toBe(false);
    expect(matches({ ...meta, tags: ['inbox/to-read'] }, body, { tags: ['inbox'] })).toBe(false);
  });

  it('combines filters with AND', () => {
    expect(matches(meta, body, { query: 'pacelc', area: 'personal', tags: ['database'] })).toBe(true);
    expect(matches(meta, body, { query: 'pacelc', area: 'work' })).toBe(false);
  });
});

describe('snippet', () => {
  const long = `${'前置き。'.repeat(30)}ここにPACELCの説明がある。${'後書き。'.repeat(60)}`;

  it('returns the beginning of the body without a query', () => {
    const result = snippet(long);
    expect(result.startsWith('前置き。')).toBe(true);
    expect(result.endsWith('…')).toBe(true);
    expect(Array.from(result)).toHaveLength(SNIPPET_LENGTH + 1);
  });

  it('returns the text around the first hit in the body', () => {
    const result = snippet(long, 'pacelc');
    expect(result.startsWith('…')).toBe(true);
    expect(result.endsWith('…')).toBe(true);
    expect(result).toContain('PACELC');
    expect(result.indexOf('PACELC')).toBeGreaterThanOrEqual(40);
    expect(Array.from(result)).toHaveLength(SNIPPET_LENGTH + 2);
  });

  it('returns the beginning when the hit is not in the body', () => {
    expect(snippet(long, 'CAP定理').startsWith('前置き。')).toBe(true);
  });

  it('shows the end of the body when the hit is near it', () => {
    const text = `${'あ'.repeat(300)}末尾のHIT`;
    const result = snippet(text, 'hit');
    expect(result.endsWith('末尾のHIT')).toBe(true);
    expect(Array.from(result)).toHaveLength(SNIPPET_LENGTH + 1);
  });

  it('collapses whitespace and returns a short body whole', () => {
    expect(snippet('  line 1\n\n  line 2\t\n')).toBe('line 1 line 2');
    expect(snippet('')).toBe('');
  });

  it('does not split surrogate pairs', () => {
    const result = snippet('📚'.repeat(400));
    expect(result).toBe(`${'📚'.repeat(SNIPPET_LENGTH)}…`);
  });
});
