import { InputValidationError } from '../../errors.js';

/** Prefix of every Notion-backed Foundation ID (collection items and areas). */
export const NOTION_ID_PREFIX = 'notion:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_UUID = /^[0-9a-f]{32}$/i;

/**
 * `notion:<page-id>` → page ID. Accepts the hyphenated UUID and the 32-hex form used in Notion URLs.
 * `from` names the tool that returns valid ids, for the error message.
 */
export function parseNotionPageId(id: string, from: string): string {
  const pageId = id.startsWith(NOTION_ID_PREFIX) ? id.slice(NOTION_ID_PREFIX.length) : undefined;
  if (!pageId || !(UUID.test(pageId) || COMPACT_UUID.test(pageId))) {
    throw new InputValidationError(`id must be "${NOTION_ID_PREFIX}<page-id>" as returned by ${from}: ${id}`);
  }
  return pageId;
}

/** `notion:<page-id>` for an ID as the Notion API returns it. */
export function formatNotionId(pageId: string): string {
  return `${NOTION_ID_PREFIX}${pageId}`;
}

/** Compares Notion IDs regardless of hyphens and case. */
export function sameNotionId(a: string, b: string): boolean {
  return compactNotionId(a) === compactNotionId(b);
}

/** The 32-hex lower-case form of a Notion ID. */
export function compactNotionId(id: string): string {
  return id.replaceAll('-', '').toLowerCase();
}

/**
 * A URL that opens the page (or database) with this ID. Built from the ID alone, so it is the same
 * whether or not the page itself was retrieved; Notion redirects it to the page's current URL.
 */
export function notionPageUrl(id: string): string {
  return `https://www.notion.so/${compactNotionId(id)}`;
}
