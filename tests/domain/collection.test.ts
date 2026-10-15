import { describe, expect, it } from 'vitest';
import {
  CollectionCreateInputSchema,
  CollectionItemSchema,
  CollectionSearchFilterSchema,
  CollectionUpdateInputSchema,
  mergeMetadata,
} from '../../src/domain/index.js';

describe('CollectionItemSchema', () => {
  it('accepts the spec §5.5 game example (no tags)', () => {
    const result = CollectionItemSchema.safeParse({
      type: 'collection',
      title: 'ペルソナ3 リロード',
      collection_type: 'game',
      status: 'playing',
      metadata: { platform: 'Xbox', rating: null },
    });
    expect(result.success).toBe(true);
  });

  it('accepts the spec §5.5 book example', () => {
    const result = CollectionItemSchema.safeParse({
      type: 'collection',
      title: 'Designing Data-Intensive Applications',
      collection_type: 'book',
      status: 'read',
      metadata: { author: 'Martin Kleppmann', rating: 5 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a cleared status', () => {
    const result = CollectionItemSchema.safeParse({ type: 'collection', title: 'a', collection_type: 'movie', status: null });
    expect(result.success).toBe(true);
  });

  it.each([
    ['unknown collection_type', { type: 'collection', title: 'a', collection_type: 'music', status: 'wishlist' }],
    ['non-object metadata', { type: 'collection', title: 'a', collection_type: 'book', status: 'read', metadata: 'x' }],
    ['array metadata', { type: 'collection', title: 'a', collection_type: 'book', status: 'read', metadata: [] }],
    ['missing status', { type: 'collection', title: 'a', collection_type: 'book' }],
    ['empty status', { type: 'collection', title: 'a', collection_type: 'book', status: '' }],
  ])('rejects %s', (_label, input) => {
    expect(CollectionItemSchema.safeParse(input).success).toBe(false);
  });
});

describe('CollectionCreateInputSchema', () => {
  const required = { title: 'ペルソナ3 リロード', collection_type: 'game', status: 'wishlist' };

  it.each([
    ['required fields only', required],
    [
      'every field (spec example)',
      { ...required, metadata: { platform: 'Xbox' }, tags: ['RPG'], note: 'セールになったら買いたい' },
    ],
    ['a null note', { ...required, note: null }],
    ['empty metadata and tags', { ...required, metadata: {}, tags: [] }],
  ])('accepts %s', (_label, input) => {
    expect(CollectionCreateInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['missing title', { collection_type: 'game', status: 'wishlist' }],
    ['missing collection_type', { title: 'a', status: 'wishlist' }],
    ['missing status', { title: 'a', collection_type: 'game' }],
    ['null status', { ...required, status: null }],
    ['empty status', { ...required, status: '' }],
    ['empty title', { ...required, title: '' }],
    ['unknown collection_type', { ...required, collection_type: 'music' }],
    ['array metadata', { ...required, metadata: [] }],
    ['empty note', { ...required, note: '' }],
    ['blank note', { ...required, note: '  \n ' }],
    ['a data source (strict)', { ...required, data_source_id: 'x' }],
  ])('rejects %s', (_label, input) => {
    expect(CollectionCreateInputSchema.safeParse(input).success).toBe(false);
  });

  it('keeps the note as given', () => {
    const result = CollectionCreateInputSchema.parse({ ...required, note: '  line 1\nline 2  ' });
    expect(result.note).toBe('  line 1\nline 2  ');
  });
});

describe('CollectionSearchFilterSchema', () => {
  it.each([
    ['an empty filter', {}],
    ['a query', { query: 'ペルソナ' }],
    ['every filter', { query: 'a', collection_type: 'book', status: 'reading', tags: ['分散システム', 'DB'] }],
  ])('accepts %s', (_label, input) => {
    expect(CollectionSearchFilterSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['an empty query', { query: '' }],
    ['unknown collection_type', { collection_type: 'music' }],
    ['a database (strict)', { database_id: 'x' }],
  ])('rejects %s', (_label, input) => {
    expect(CollectionSearchFilterSchema.safeParse(input).success).toBe(false);
  });
});

describe('CollectionUpdateInputSchema', () => {
  const id = 'notion:0f9e3c1a-1111-2222-3333-444455556666';

  it.each([
    ['status', { id, status: 'completed' }],
    ['a cleared status', { id, status: null }],
    ['metadata', { id, metadata: { rating: 5 } }],
    ['empty metadata', { id, metadata: {} }],
    ['tags', { id, tags: ['RPG', 'Xbox'] }],
    ['empty tags', { id, tags: [] }],
    ['append_note', { id, append_note: 'ストーリー後半が特によかった' }],
    ['the spec example', { id, status: 'completed', metadata: { rating: 5 }, tags: ['RPG'], append_note: 'よかった' }],
    ['a null append_note with another field', { id, status: 'completed', append_note: null }],
  ])('accepts %s', (_label, input) => {
    expect(CollectionUpdateInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['id only', { id }],
    ['only a null append_note', { id, append_note: null }],
    ['missing id', { status: 'completed' }],
    ['an empty status', { id, status: '' }],
    ['an empty append_note', { id, append_note: '' }],
    ['a title (not updatable)', { id, title: 'renamed' }],
    ['a collection_type (not updatable)', { id, collection_type: 'book' }],
  ])('rejects %s', (_label, input) => {
    expect(CollectionUpdateInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('mergeMetadata', () => {
  it.each([
    ['adds and overwrites keys (spec example)', { platform: 'Xbox', rating: null }, { rating: 5 }, { platform: 'Xbox', rating: 5 }],
    ['stores null as a value', { rating: 5 }, { rating: null }, { rating: null }],
    ['replaces nested objects', { a: { x: 1 } }, { a: { y: 2 } }, { a: { y: 2 } }],
    ['merges into empty metadata', {}, { platform: 'Switch' }, { platform: 'Switch' }],
    ['keeps everything for an empty patch', { platform: 'Xbox' }, {}, { platform: 'Xbox' }],
  ])('%s', (_label, current, patch, expected) => {
    expect(mergeMetadata(current, patch)).toEqual(expected);
  });

  it('does not modify its arguments', () => {
    const current = { a: 1 };
    mergeMetadata(current, { a: 2 });
    expect(current).toEqual({ a: 1 });
  });
});
