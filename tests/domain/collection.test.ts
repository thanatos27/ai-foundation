import { describe, expect, it } from 'vitest';
import { CollectionItemSchema } from '../../src/domain/index.js';

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

  it.each([
    ['unknown collection_type', { type: 'collection', title: 'a', collection_type: 'music', status: 'wishlist' }],
    ['non-object metadata', { type: 'collection', title: 'a', collection_type: 'book', status: 'read', metadata: 'x' }],
    ['array metadata', { type: 'collection', title: 'a', collection_type: 'book', status: 'read', metadata: [] }],
    ['missing status', { type: 'collection', title: 'a', collection_type: 'book' }],
  ])('rejects %s', (_label, input) => {
    expect(CollectionItemSchema.safeParse(input).success).toBe(false);
  });
});
