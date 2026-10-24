import {
  type BlockObjectResponse,
  isFullBlock,
  isFullPage,
  type ListBlockChildrenResponse,
  type PageObjectResponse,
} from '@notionhq/client';
import type { AreaGetResult, AreaListFilter, AreaResource } from '../../domain/index.js';
import { ConfigurationError, type FoundationError, NotFoundError, ProviderApiError } from '../../errors.js';
import type { AreaConnector } from '../types.js';
import { AREA_CONTENT_DEPTH, type BlockNode, expandsChildren, renderAreaContent, UNTITLED } from './area-content.js';
import { type NotionClient, toFoundationError } from './client.js';
import { compactNotionId, formatNotionId, notionPageUrl, parseNotionPageId, sameNotionId } from './id.js';

const PAGE_SIZE = 100;

export interface NotionAreaConnectorOptions {
  /** Resolves the SDK client; called on every operation (memoize it). */
  client: () => Promise<NotionClient>;
  /** `sources.area.notion.parent_page_id`: the page whose direct child pages are the areas. */
  parentPageId: string | undefined;
}

/**
 * Area connector for Notion. Read-only: it calls `pages.retrieve` and `blocks.children.list` only.
 *
 * The areas are the child pages directly under the configured parent page. `list` reads them from the
 * parent's blocks; `get` accepts a page only if its parent is that page. For the same Notion state both
 * describe the same set: a page placed in a column, a toggle or a deeper page has a block parent (or
 * another page) and is in neither. Pages in the trash are excluded by `in_trash` in both.
 */
export class NotionAreaConnector implements AreaConnector {
  constructor(private readonly options: NotionAreaConnectorOptions) {}

  async list(filter: AreaListFilter): Promise<AreaResource[]> {
    const parentPageId = this.parentPageId();
    const api = await this.options.client();
    await this.checkParent(api, parentPageId);
    const blocks = await this.children(api, parentPageId, (error) => this.parentNotFound(parentPageId, error));
    const areas = blocks
      .filter((block) => block.type === 'child_page' && !block.in_trash)
      .map((block) => areaFromChildPage(block));
    return sortAreas(areas.filter((area) => matchesFilter(area, filter)));
  }

  async get(id: string): Promise<AreaGetResult> {
    const pageId = parseNotionPageId(id, 'area_list');
    const parentPageId = this.parentPageId();
    const api = await this.options.client();
    await this.checkParent(api, parentPageId);

    const notFound = (cause?: unknown) => new NotFoundError(`area ${id}`, { cause });
    const page = await api.pages.retrieve({ page_id: pageId }).catch((error: unknown) => {
      throw toFoundationError(error, { notFound: () => notFound(error) });
    });
    const isArea =
      isFullPage(page) &&
      !page.in_trash &&
      page.parent.type === 'page_id' &&
      sameNotionId(page.parent.page_id, parentPageId);
    // A page outside the areas is reported as missing rather than revealed.
    if (!isArea) throw notFound();

    const nodes = await this.blockTree(api, page.id, 1, notFound);
    return { area: areaFromPage(page), content: renderAreaContent(nodes) };
  }

  private parentPageId(): string {
    const id = this.options.parentPageId;
    if (!id) throw new ConfigurationError('sources.area.notion.parent_page_id is not set');
    return id;
  }

  /** Checked on every call, so that a parent moved to the trash or unshared is reported as such. */
  private async checkParent(api: NotionClient, parentPageId: string): Promise<void> {
    const parent = await api.pages.retrieve({ page_id: parentPageId }).catch((error: unknown) => {
      throw toFoundationError(error, { notFound: () => this.parentNotFound(parentPageId, error) });
    });
    if (!isFullPage(parent) || parent.in_trash) throw this.parentNotFound(parentPageId);
  }

  /** Every child block, across all pages of results. Any failure fails the whole call. */
  private async children(
    api: NotionClient,
    blockId: string,
    notFound: (error: unknown) => FoundationError,
  ): Promise<BlockObjectResponse[]> {
    const blocks: BlockObjectResponse[] = [];
    let cursor: string | undefined;
    do {
      const response: ListBlockChildrenResponse = await api.blocks.children
        .list({ block_id: blockId, page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) })
        .catch((error: unknown) => {
          throw toFoundationError(error, { notFound: () => notFound(error) });
        });
      for (const block of response.results) {
        // A block without its type cannot be classified; dropping it could hide an area or content.
        if (!isFullBlock(block)) {
          throw new ProviderApiError('Notion', `block ${block.id} under ${blockId} was returned without its content`);
        }
        blocks.push(block);
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return blocks;
  }

  /** The blocks of an area page, with the children of nested lists, toggles and columns up to the depth limit. */
  private async blockTree(
    api: NotionClient,
    blockId: string,
    depth: number,
    notFound: (error: unknown) => FoundationError,
  ): Promise<BlockNode[]> {
    const nodes: BlockNode[] = [];
    for (const block of await this.children(api, blockId, notFound)) {
      if (!expandsChildren(block)) nodes.push({ block });
      else if (depth >= AREA_CONTENT_DEPTH) nodes.push({ block, depthLimited: true });
      else nodes.push({ block, children: await this.blockTree(api, block.id, depth + 1, notFound) });
    }
    return nodes;
  }

  private parentNotFound(parentPageId: string, cause?: unknown): ConfigurationError {
    return new ConfigurationError(
      `Notion page ${parentPageId} (sources.area.notion.parent_page_id) was not found, is in the trash ` +
        `or is not shared with the AI Foundation connection`,
      { cause },
    );
  }
}

function area(id: string, title: string): AreaResource {
  return { id: formatNotionId(id), type: 'area', title: title || UNTITLED, source: 'notion', external_ref: notionPageUrl(id) };
}

/** From a `child_page` block of the parent page: the page itself is not retrieved. */
function areaFromChildPage(block: BlockObjectResponse): AreaResource {
  return area(block.id, block.type === 'child_page' ? block.child_page.title : '');
}

/** The title is the one property of type `title`, whatever its name. */
function areaFromPage(page: PageObjectResponse): AreaResource {
  const titles = Object.values(page.properties).filter((property) => property.type === 'title');
  const [title] = titles;
  if (titles.length !== 1 || title?.type !== 'title') {
    throw new ProviderApiError('Notion', `page ${page.id} does not have exactly one title property`);
  }
  return area(page.id, title.title.map((item) => item.plain_text).join(''));
}

const fold = (text: string) => text.toLowerCase();

/** Ordinal comparison: independent of the runtime locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `query` is a case-insensitive substring of the title. */
export function matchesFilter(area: AreaResource, { query }: AreaListFilter): boolean {
  return query === undefined || fold(area.title).includes(fold(query));
}

/**
 * Sorted by title ignoring case, then by exact title, then by id, so the order never depends on the
 * provider. An area seen twice (blocks can shift while paginating) is kept once.
 */
export function sortAreas(areas: readonly AreaResource[]): AreaResource[] {
  const unique = new Map<string, AreaResource>();
  for (const item of areas) {
    const key = compactNotionId(item.id);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort(
    (a, b) => compare(fold(a.title), fold(b.title)) || compare(a.title, b.title) || compare(a.id, b.id),
  );
}
