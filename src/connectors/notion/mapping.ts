import type { PageObjectResponse } from '@notionhq/client';
import {
  type CollectionItem,
  type CollectionMetadata,
  type CollectionType,
  CollectionTypeSchema,
} from '../../domain/index.js';
import { InputValidationError } from '../../errors.js';
import { PROPERTY } from './schema.js';

// Notion request limits (https://developers.notion.com/reference/request-limits).
/** Characters in one rich text object's `text.content`. */
export const RICH_TEXT_CONTENT_LIMIT = 2000;
/** Elements in a rich text array (one property value or one paragraph). */
export const RICH_TEXT_ARRAY_LIMIT = 100;
/** Options in one multi-select value. */
export const MULTI_SELECT_LIMIT = 100;
/** Size of a request body. 500KB, read as 500,000 bytes to stay under either reading of "KB". */
export const REQUEST_BODY_LIMIT_BYTES = 500_000;

export const COLLECTION_ID_PREFIX = 'notion:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_UUID = /^[0-9a-f]{32}$/i;

export interface TextRichText {
  type: 'text';
  text: { content: string };
}

/** `notion:<page-id>` → page ID. Accepts the hyphenated UUID and the 32-hex form used in Notion URLs. */
export function parseCollectionId(id: string): string {
  const pageId = id.startsWith(COLLECTION_ID_PREFIX) ? id.slice(COLLECTION_ID_PREFIX.length) : undefined;
  if (!pageId || !(UUID.test(pageId) || COMPACT_UUID.test(pageId))) {
    throw new InputValidationError(`id must be "${COLLECTION_ID_PREFIX}<page-id>" as returned by collection_search: ${id}`);
  }
  return pageId;
}

/** Compares Notion IDs regardless of hyphens and case. */
export function sameNotionId(a: string, b: string): boolean {
  const normalize = (id: string) => id.replaceAll('-', '').toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * Splits `text` into rich text objects of at most 2,000 characters without breaking a surrogate
 * pair. Text that needs more than 100 objects is rejected, never truncated.
 */
export function richText(text: string, field: string): TextRichText[] {
  const chunks: TextRichText[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + RICH_TEXT_CONTENT_LIMIT, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    chunks.push({ type: 'text', text: { content: text.slice(start, end) } });
    start = end;
  }
  if (chunks.length > RICH_TEXT_ARRAY_LIMIT) {
    throw new InputValidationError(
      `${field} is ${text.length} characters; Notion allows at most ${RICH_TEXT_CONTENT_LIMIT * RICH_TEXT_ARRAY_LIMIT}`,
    );
  }
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** A paragraph block holding `text` as plain text. */
export function paragraph(text: string, field: string) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text, field) } } as const;
}

/** A select option name. Notion does not allow commas in option names. */
export function selectOption(name: string, field: string): { name: string } {
  if (name.includes(',')) {
    throw new InputValidationError(`${field} must not contain commas (Notion select option names): "${name}"`);
  }
  return { name };
}

/** Multi-select options for `tags`: duplicates removed (order kept), at most 100 distinct values. */
export function tagOptions(tags: readonly string[]): { name: string }[] {
  const distinct = [...new Set(tags)];
  if (distinct.length > MULTI_SELECT_LIMIT) {
    throw new InputValidationError(
      `tags has ${distinct.length} distinct values; Notion allows at most ${MULTI_SELECT_LIMIT}`,
    );
  }
  return distinct.map((tag) => selectOption(tag, 'tags'));
}

/** The `Metadata` property value: the metadata as compact JSON. */
export function metadataRichText(metadata: CollectionMetadata): TextRichText[] {
  return richText(JSON.stringify(metadata), 'metadata JSON');
}

/**
 * Rejects a request whose body would exceed Notion's 500KB limit. `body` is exactly what the SDK
 * sends (the parameters without path parameters such as `page_id`). `fields` names what the user
 * can shorten.
 */
export function assertRequestSize(body: unknown, fields: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > REQUEST_BODY_LIMIT_BYTES) {
    throw new InputValidationError(
      `the Notion request would be ${bytes} bytes; Notion allows at most ${REQUEST_BODY_LIMIT_BYTES} bytes (${fields} combined)`,
    );
  }
}

type PageProperty = PageObjectResponse['properties'][string];

function pageProperty<T extends PageProperty['type']>(
  page: PageObjectResponse,
  name: string,
  type: T,
): Extract<PageProperty, { type: T }> | undefined {
  const value = page.properties[name];
  return value?.type === type ? (value as Extract<PageProperty, { type: T }>) : undefined;
}

const plainText = (items: readonly { plain_text: string }[]) => items.map((item) => item.plain_text).join('');

/** The page's `Type`, or undefined when it is empty or not one of the collection types. */
export function collectionTypeOf(page: PageObjectResponse): CollectionType | undefined {
  const name = pageProperty(page, PROPERTY.collectionType, 'select')?.select?.name;
  const parsed = CollectionTypeSchema.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The page's `Metadata` as an object: `{}` when empty, undefined when it is not a JSON object
 * (e.g. edited by hand in Notion).
 */
export function readMetadata(page: PageObjectResponse): CollectionMetadata | undefined {
  const text = plainText(pageProperty(page, PROPERTY.metadata, 'rich_text')?.rich_text ?? []);
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as CollectionMetadata)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Converts a page whose `Type` is valid (see `collectionTypeOf`) to a collection item. */
export function toCollectionItem(page: PageObjectResponse, collectionType: CollectionType): CollectionItem {
  const metadata = readMetadata(page);
  return {
    id: `${COLLECTION_ID_PREFIX}${page.id}`,
    source: 'notion',
    external_ref: page.url,
    type: 'collection',
    title: plainText(pageProperty(page, PROPERTY.title, 'title')?.title ?? []) || '(Untitled)',
    collection_type: collectionType,
    status: pageProperty(page, PROPERTY.status, 'select')?.select?.name ?? null,
    // Omitted when unreadable, so a broken value is never reported as empty.
    ...(metadata ? { metadata } : {}),
    tags: (pageProperty(page, PROPERTY.tags, 'multi_select')?.multi_select ?? []).map((option) => option.name),
  };
}
