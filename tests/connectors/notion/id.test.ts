import { describe, expect, it } from 'vitest';
import {
  compactNotionId,
  formatNotionId,
  notionPageUrl,
  parseNotionPageId,
  sameNotionId,
} from '../../../src/connectors/notion/id.js';
import { parseCollectionId } from '../../../src/connectors/notion/mapping.js';
import { InputValidationError } from '../../../src/errors.js';

const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const COMPACT = '0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d';

describe('parseNotionPageId', () => {
  it.each([UUID, COMPACT, UUID.toUpperCase()])('accepts notion:%s', (pageId) => {
    expect(parseNotionPageId(`notion:${pageId}`, 'area_list')).toBe(pageId);
  });

  it.each(['', UUID, `notion:`, `obsidian:${UUID}`, `notion:${COMPACT}0`, 'notion:meals', ` notion:${UUID}`])(
    'rejects %j, naming the tool that returns valid ids',
    (id) => {
      expect(() => parseNotionPageId(id, 'area_list')).toThrow(InputValidationError);
      expect(() => parseNotionPageId(id, 'area_list')).toThrow(
        `Invalid input: id must be "notion:<page-id>" as returned by area_list: ${id}`,
      );
    },
  );

  it('keeps the collection message unchanged', () => {
    expect(() => parseCollectionId('bad')).toThrow(
      'Invalid input: id must be "notion:<page-id>" as returned by collection_search: bad',
    );
  });
});

describe('Notion id helpers', () => {
  it('formats the id as the API returns it', () => {
    expect(formatNotionId(UUID)).toBe(`notion:${UUID}`);
  });

  it('compares and compacts regardless of hyphens and case', () => {
    expect(compactNotionId(UUID.toUpperCase())).toBe(COMPACT);
    expect(sameNotionId(UUID, COMPACT.toUpperCase())).toBe(true);
    expect(sameNotionId(UUID, UUID.replace('4a6b', '4a6c'))).toBe(false);
  });

  it('builds the same page URL from either form', () => {
    expect(notionPageUrl(UUID)).toBe(`https://www.notion.so/${COMPACT}`);
    expect(notionPageUrl(COMPACT.toUpperCase())).toBe(`https://www.notion.so/${COMPACT}`);
  });
});
