import type { PageObjectResponse } from '@notionhq/client';
import { describe, expect, it } from 'vitest';
import {
  assertRequestSize,
  collectionTypeOf,
  paragraph,
  parseCollectionId,
  readMetadata,
  REQUEST_BODY_LIMIT_BYTES,
  richText,
  sameNotionId,
  selectOption,
  tagOptions,
  toCollectionItem,
} from '../../../src/connectors/notion/mapping.js';
import { InputValidationError } from '../../../src/errors.js';
import { FakeNotion } from './fake-client.js';

const UUID = '0f9e3c1a-1111-2222-3333-444455556666';

function seeded(seed: Parameters<FakeNotion['seed']>[0]): PageObjectResponse {
  const fake = new FakeNotion();
  return fake.storedPages.get(fake.seed(seed))!;
}

const join = (chunks: { text: { content: string } }[]) => chunks.map((chunk) => chunk.text.content).join('');

describe('parseCollectionId', () => {
  it.each([
    [`notion:${UUID}`, UUID],
    [`notion:${UUID.replaceAll('-', '')}`, UUID.replaceAll('-', '')],
    [`notion:${UUID.toUpperCase()}`, UUID.toUpperCase()],
  ])('accepts %s', (id, pageId) => {
    expect(parseCollectionId(id)).toBe(pageId);
  });

  it.each([UUID, `todoist:${UUID}`, 'notion:', 'notion:abc', `notion:${UUID}x`, `notion:${UUID}/x`])(
    'rejects %s',
    (id) => {
      expect(() => parseCollectionId(id)).toThrow(InputValidationError);
    },
  );
});

describe('sameNotionId', () => {
  it('ignores hyphens and case', () => {
    expect(sameNotionId(UUID, UUID.replaceAll('-', '').toUpperCase())).toBe(true);
    expect(sameNotionId(UUID, UUID.replace('0f9e', '0f9f'))).toBe(false);
  });
});

describe('richText', () => {
  it('returns nothing for empty text and one object for short text', () => {
    expect(richText('', 'note')).toEqual([]);
    expect(richText('感想', 'note')).toEqual([{ type: 'text', text: { content: '感想' } }]);
  });

  it('splits at 2,000 characters and joins back to the original', () => {
    const text = 'あ'.repeat(4001);
    const chunks = richText(text, 'note');
    expect(chunks.map((chunk) => chunk.text.content.length)).toEqual([2000, 2000, 1]);
    expect(join(chunks)).toBe(text);
  });

  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(1999)}😀${'b'.repeat(10)}`;
    const chunks = richText(text, 'note');
    expect(chunks[0]!.text.content).toBe('a'.repeat(1999));
    expect(chunks[1]!.text.content.startsWith('😀')).toBe(true);
    expect(join(chunks)).toBe(text);
  });

  it('accepts exactly 200,000 characters and rejects more without truncating', () => {
    expect(richText('x'.repeat(200_000), 'metadata JSON')).toHaveLength(100);
    expect(() => richText('x'.repeat(200_001), 'metadata JSON')).toThrow(
      'Invalid input: metadata JSON is 200001 characters; Notion allows at most 200000',
    );
  });
});

describe('paragraph', () => {
  it('is a plain-text paragraph keeping newlines', () => {
    expect(paragraph('line 1\nline 2', 'note')).toEqual({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: 'line 1\nline 2' } }] },
    });
  });
});

describe('selectOption / tagOptions', () => {
  it('rejects commas', () => {
    expect(() => selectOption('a,b', 'status')).toThrow('status must not contain commas');
    expect(() => tagOptions(['RPG', 'a,b'])).toThrow('tags must not contain commas');
  });

  it('does not limit option name length', () => {
    expect(selectOption('x'.repeat(300), 'status')).toEqual({ name: 'x'.repeat(300) });
  });

  it('removes duplicate tags, keeping order', () => {
    expect(tagOptions(['RPG', 'Xbox', 'RPG'])).toEqual([{ name: 'RPG' }, { name: 'Xbox' }]);
  });

  it('accepts 100 distinct tags and rejects 101', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `t${i}`);
    expect(tagOptions(hundred)).toHaveLength(100);
    expect(() => tagOptions([...hundred, 't100'])).toThrow(
      'Invalid input: tags has 101 distinct values; Notion allows at most 100',
    );
  });

  it('counts distinct tags: 101 values with a duplicate are 100 tags', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `t${i}`);
    expect(tagOptions([...hundred, 't0'])).toHaveLength(100);
  });
});

describe('assertRequestSize', () => {
  // `{"v":"…"}` adds 8 bytes of JSON around the value.
  const body = (value: string) => ({ v: value });
  const OVERHEAD = Buffer.byteLength(JSON.stringify(body('')));

  it.each([
    ['ASCII', 'a', 1],
    ['Japanese', 'あ', 3],
    ['emoji', '😀', 4],
  ])('accepts exactly the limit and rejects one byte more (%s)', (_label, char, bytes) => {
    const fitting = Math.floor((REQUEST_BODY_LIMIT_BYTES - OVERHEAD) / bytes);
    const padding = REQUEST_BODY_LIMIT_BYTES - OVERHEAD - fitting * bytes;
    const atLimit = char.repeat(fitting) + 'a'.repeat(padding);
    expect(Buffer.byteLength(JSON.stringify(body(atLimit)))).toBe(REQUEST_BODY_LIMIT_BYTES);
    expect(() => assertRequestSize(body(atLimit), 'note')).not.toThrow();
    expect(() => assertRequestSize(body(`${atLimit}a`), 'note')).toThrow(
      'Invalid input: the Notion request would be 500001 bytes; Notion allows at most 500000 bytes (note combined)',
    );
  });

  it('counts JSON escaping', () => {
    const quotes = '"'.repeat(250_000); // 250,000 characters, 500,000 bytes once escaped
    expect(() => assertRequestSize(body(quotes), 'metadata')).toThrow(InputValidationError);
  });
});

describe('readMetadata', () => {
  it.each([
    ['empty', '', {}],
    ['blank', '  ', {}],
    ['an object', '{"platform":"Xbox","rating":null}', { platform: 'Xbox', rating: null }],
  ])('reads %s metadata', (_label, text, expected) => {
    expect(readMetadata(seeded({ metadata: text }))).toEqual(expected);
  });

  it.each([
    ['invalid JSON', '{platform: Xbox}'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a number', '5'],
    ['a string', '"x"'],
  ])('treats %s as unreadable', (_label, text) => {
    expect(readMetadata(seeded({ metadata: text }))).toBeUndefined();
  });
});

describe('toCollectionItem', () => {
  it('maps every property', () => {
    const page = seeded({
      id: UUID,
      title: 'ペルソナ3 リロード',
      type: 'game',
      status: 'playing',
      tags: ['RPG', 'Xbox'],
      metadata: '{"platform":"Xbox"}',
    });
    expect(toCollectionItem(page, 'game')).toEqual({
      id: `notion:${UUID}`,
      source: 'notion',
      external_ref: `https://www.notion.so/${UUID.replaceAll('-', '')}`,
      type: 'collection',
      title: 'ペルソナ3 リロード',
      collection_type: 'game',
      status: 'playing',
      metadata: { platform: 'Xbox' },
      tags: ['RPG', 'Xbox'],
    });
  });

  it('fills in empty values', () => {
    const item = toCollectionItem(seeded({ title: '', status: null, tags: [], metadata: '' }), 'book');
    expect(item).toMatchObject({ title: '(Untitled)', status: null, tags: [], metadata: {} });
  });

  it('omits unreadable metadata', () => {
    const item = toCollectionItem(seeded({ metadata: 'not json' }), 'book');
    expect(item).not.toHaveProperty('metadata');
  });
});

describe('collectionTypeOf', () => {
  it.each([
    ['game', 'game'],
    ['other', 'other'],
    ['music', undefined],
    ['Game', undefined],
    [null, undefined],
  ])('reads %s as %s', (type, expected) => {
    expect(collectionTypeOf(seeded({ type }))).toBe(expected);
  });
});
