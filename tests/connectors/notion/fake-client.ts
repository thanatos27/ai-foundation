import { APIErrorCode, APIResponseError, type PageObjectResponse } from '@notionhq/client';
import type { NotionClient } from '../../../src/connectors/notion/client.js';
import type { DataSourceProperty } from '../../../src/connectors/notion/schema.js';

export const DATA_SOURCE_ID = '11111111-2222-3333-4444-555555555555';
export const OTHER_DATA_SOURCE_ID = '99999999-8888-7777-6666-555555555555';

export const COLLECTION_PROPERTIES: Record<string, DataSourceProperty> = {
  Name: { type: 'title' },
  Type: { type: 'select' },
  Status: { type: 'select' },
  Tags: { type: 'multi_select' },
  Metadata: { type: 'rich_text' },
};

type Method =
  | 'dataSources.retrieve'
  | 'dataSources.query'
  | 'pages.create'
  | 'pages.retrieve'
  | 'pages.update'
  | 'blocks.children.append'
  | 'blocks.children.list';

type Args = Record<string, any>;

/** A Notion API error as the SDK throws it. */
export function apiError(status: number, code: APIErrorCode, message = `${code} message`): APIResponseError {
  return new APIResponseError({
    code,
    status,
    message,
    headers: {},
    rawBodyText: JSON.stringify({ object: 'error', status, code, message }),
    additional_data: undefined,
    request_id: undefined,
  });
}

export interface PageSeed {
  id?: string;
  title?: string;
  type?: string | null;
  status?: string | null;
  tags?: string[];
  /** Raw text of the Metadata property. */
  metadata?: string;
  parentDataSourceId?: string;
  inTrash?: boolean;
  lastEdited?: number;
}

/** A plain page (not a data source row), e.g. the Areas parent page or an area. */
export interface PlainPageSeed {
  id?: string;
  title?: string;
  /** Name of the title property; Notion uses `title` for plain pages. */
  titleProperty?: string;
  /** Parent page; omitted for a workspace-level page. */
  parentPageId?: string;
  /** Parent block (a column, toggle, ...) instead of a page. */
  parentBlockId?: string;
  inTrash?: boolean;
  isArchived?: boolean;
}

export interface BlockSeed {
  id?: string;
  type: string;
  /** The type-specific payload, e.g. `{ rich_text: [...] }` or `{ title: 'Meals' }`. */
  content?: Record<string, unknown>;
  inTrash?: boolean;
  /** Nested blocks; `has_children` follows from them. */
  children?: BlockSeed[];
}

/** A rich text item as Notion returns it. */
export function richTextItem(text: string, href: string | null = null) {
  return { type: 'text', text: { content: text, link: href ? { url: href } : null }, plain_text: text, href, annotations: {} };
}

const richTextResponse = (text: string) =>
  text === '' ? [] : [{ type: 'text', text: { content: text, link: null }, plain_text: text, href: null }];

const joinRequestText = (items: { text: { content: string } }[] | undefined) =>
  (items ?? []).map((item) => item.text.content).join('');

/**
 * In-memory Notion with one workspace: data sources (by ID → properties), pages and their blocks.
 * It understands the request shapes the connector sends and records every call.
 */
export class FakeNotion {
  readonly calls: { method: Method; args: Args }[] = [];
  /** Data source ID → property schema. */
  dataSourceSchemas = new Map<string, Record<string, DataSourceProperty>>([
    [DATA_SOURCE_ID, structuredClone(COLLECTION_PROPERTIES)],
  ]);
  readonly storedPages = new Map<string, PageObjectResponse>();
  /** Page ID → its paragraphs, in order. */
  readonly storedBlocks = new Map<string, { type: string; text: string }[]>();
  /** Block or page ID → its child blocks as `blocks.children.list` returns them. */
  readonly childBlocks = new Map<string, Record<string, unknown>[]>();
  /** Errors to throw, per method, consumed in order. */
  readonly failures = new Map<Method, Error[]>();
  /** Maximum results per query response, to exercise pagination. */
  pageSize = 100;
  incompleteQuery = false;
  private sequence = 0;
  private clock = 0;

  failNext(method: Method, error: Error): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }

  callsTo(method: Method): Args[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  /** Adds a page as if it had been created in Notion (possibly by hand). Returns its ID. */
  seed(seed: PageSeed = {}): string {
    const id = seed.id ?? this.nextId();
    const properties: Record<string, unknown> = {
      Name: { id: 'title', type: 'title', title: richTextResponse(seed.title ?? 'Seeded') },
      Type: { id: 't', type: 'select', select: seed.type === null ? null : { id: 'o', name: seed.type ?? 'book', color: 'default' } },
      Status: { id: 's', type: 'select', select: seed.status == null ? null : { id: 'o', name: seed.status, color: 'default' } },
      Tags: { id: 'g', type: 'multi_select', multi_select: (seed.tags ?? []).map((name) => ({ id: 'o', name, color: 'default' })) },
      Metadata: { id: 'm', type: 'rich_text', rich_text: richTextResponse(seed.metadata ?? '') },
    };
    this.storedPages.set(id, this.pageObject(id, properties, seed));
    this.storedBlocks.set(id, []);
    return id;
  }

  /** Adds a plain page and, when its parent is a page, the `child_page` block for it. Returns its ID. */
  seedPlainPage(seed: PlainPageSeed = {}): string {
    const id = seed.id ?? this.nextId();
    const title = seed.title ?? 'Seeded';
    const parent = seed.parentPageId
      ? { type: 'page_id', page_id: seed.parentPageId }
      : seed.parentBlockId
        ? { type: 'block_id', block_id: seed.parentBlockId }
        : { type: 'workspace', workspace: true };
    this.storedPages.set(id, {
      object: 'page',
      id,
      created_time: this.tick(),
      last_edited_time: this.tick(),
      in_trash: seed.inTrash ?? false,
      is_archived: seed.isArchived ?? false,
      url: `https://app.notion.com/p/${id.replaceAll('-', '')}`,
      parent,
      properties: { [seed.titleProperty ?? 'title']: { id: 'title', type: 'title', title: title === '' ? [] : [richTextItem(title)] } },
    } as unknown as PageObjectResponse);
    this.childBlocks.set(id, this.childBlocks.get(id) ?? []);
    // Like Notion, a page in the trash no longer appears among its parent's blocks.
    const parentId = seed.parentPageId ?? seed.parentBlockId;
    if (parentId && !seed.inTrash) {
      this.appendBlocks(parentId, [{ id, type: 'child_page', content: { title } }]);
    }
    return id;
  }

  /** Adds blocks (with their nested blocks) to the end of a page or block. Returns their IDs. */
  appendBlocks(parentId: string, seeds: BlockSeed[]): string[] {
    const list = this.childBlocks.get(parentId) ?? [];
    this.childBlocks.set(parentId, list);
    return seeds.map((seed) => {
      const id = seed.id ?? this.nextId();
      list.push({
        object: 'block',
        id,
        type: seed.type,
        [seed.type]: seed.content ?? {},
        has_children: (seed.children?.length ?? 0) > 0 || (seed.type === 'child_page' && this.childBlocks.has(id)),
        in_trash: seed.inTrash ?? false,
        parent: { type: 'page_id', page_id: parentId },
      });
      if (seed.children) this.appendBlocks(id, seed.children);
      return id;
    });
  }

  private readonly dataSources: NotionClient['dataSources'] = {
    retrieve: (async (args: Args) => {
      this.record('dataSources.retrieve', args);
      const schema = this.dataSourceSchemas.get(args.data_source_id);
      if (!schema) throw apiError(404, APIErrorCode.ObjectNotFound);
      return { object: 'data_source', id: args.data_source_id, title: [], properties: schema };
    }) as any,

    query: (async (args: Args) => {
      this.record('dataSources.query', args);
      if (!this.dataSourceSchemas.has(args.data_source_id)) throw apiError(404, APIErrorCode.ObjectNotFound);
      const matching = [...this.storedPages.values()]
        .filter((page) => this.parentOf(page) === args.data_source_id && !page.in_trash)
        .filter((page) => (args.filter ? matches(page, args.filter) : true))
        .sort((a, b) => Date.parse(b.last_edited_time) - Date.parse(a.last_edited_time));
      const start = args.start_cursor ? Number(args.start_cursor) : 0;
      const size = Math.min(args.page_size ?? 100, this.pageSize);
      const results = matching.slice(start, start + size);
      const hasMore = start + size < matching.length;
      return {
        object: 'list',
        type: 'page_or_data_source',
        page_or_data_source: {},
        results,
        has_more: hasMore,
        next_cursor: hasMore ? String(start + size) : null,
        ...(this.incompleteQuery
          ? { request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' } }
          : {}),
      };
    }) as any,
  };

  private readonly pages: NotionClient['pages'] = {
    create: (async (args: Args) => {
      this.record('pages.create', args);
      const dataSourceId = args.parent.data_source_id;
      if (!this.dataSourceSchemas.has(dataSourceId)) throw apiError(404, APIErrorCode.ObjectNotFound);
      const id = this.nextId();
      const page = this.pageObject(id, this.toResponseProperties(args.properties, dataSourceId), {
        parentDataSourceId: dataSourceId,
      });
      this.storedPages.set(id, page);
      this.storedBlocks.set(id, (args.children ?? []).map(blockText));
      return page;
    }) as any,

    retrieve: (async (args: Args) => {
      this.record('pages.retrieve', args);
      return structuredClone(this.findPage(args.page_id));
    }) as any,

    update: (async (args: Args) => {
      this.record('pages.update', args);
      const page = this.findPage(args.page_id);
      Object.assign(page.properties, this.toResponseProperties(args.properties ?? {}, this.parentOf(page)));
      page.last_edited_time = this.tick();
      return structuredClone(page);
    }) as any,
  };

  private readonly blocks: NotionClient['blocks'] = {
    children: {
      append: (async (args: Args) => {
        this.record('blocks.children.append', args);
        this.findPage(args.block_id);
        this.storedBlocks.get(this.pageKey(args.block_id)!)!.push(...args.children.map(blockText));
        return { object: 'list', results: [] };
      }) as any,

      list: (async (args: Args) => {
        this.record('blocks.children.list', args);
        const key = [...this.childBlocks.keys()].find((id) => sameId(id, args.block_id));
        if (!key) throw apiError(404, APIErrorCode.ObjectNotFound);
        const all = this.childBlocks.get(key)!;
        const start = args.start_cursor ? Number(args.start_cursor) : 0;
        const size = Math.min(args.page_size ?? 100, this.pageSize);
        const hasMore = start + size < all.length;
        return {
          object: 'list',
          type: 'block',
          block: {},
          results: structuredClone(all.slice(start, start + size)),
          has_more: hasMore,
          next_cursor: hasMore ? String(start + size) : null,
        };
      }) as any,
    },
  };

  /** The client the connector talks to. */
  readonly client: NotionClient = { dataSources: this.dataSources, pages: this.pages, blocks: this.blocks };

  /** Raw Metadata text currently stored on a page. */
  metadataText(id: string): string {
    const property = this.findPage(id).properties.Metadata as { rich_text: { plain_text: string }[] };
    return property.rich_text.map((item) => item.plain_text).join('');
  }

  private record(method: Method, args: Args): void {
    this.calls.push({ method, args: structuredClone(args) });
    const queue = this.failures.get(method);
    const failure = queue?.shift();
    if (failure) throw failure;
  }

  private pageKey(pageId: string): string | undefined {
    return [...this.storedPages.keys()].find((id) => sameId(id, pageId));
  }

  private findPage(pageId: string): PageObjectResponse {
    const key = this.pageKey(pageId);
    if (!key) throw apiError(404, APIErrorCode.ObjectNotFound);
    return this.storedPages.get(key)!;
  }

  private parentOf(page: PageObjectResponse): string | undefined {
    return page.parent.type === 'data_source_id' ? page.parent.data_source_id : undefined;
  }

  private nextId(): string {
    this.sequence += 1;
    return `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`;
  }

  private tick(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 15, 0, 0, this.clock)).toISOString();
  }

  private pageObject(id: string, properties: Record<string, unknown>, seed: PageSeed): PageObjectResponse {
    const lastEdited =
      seed.lastEdited !== undefined ? new Date(Date.UTC(2026, 9, 1, 0, 0, seed.lastEdited)).toISOString() : this.tick();
    return {
      object: 'page',
      id,
      created_time: lastEdited,
      last_edited_time: lastEdited,
      in_trash: seed.inTrash ?? false,
      url: `https://www.notion.so/${id.replaceAll('-', '')}`,
      parent: { type: 'data_source_id', data_source_id: seed.parentDataSourceId ?? DATA_SOURCE_ID, database_id: 'db' },
      properties,
    } as unknown as PageObjectResponse;
  }

  /**
   * Like Notion, option names are unique regardless of case: an existing option is reused with its
   * own spelling, and an unknown one is added to the data source.
   */
  private optionName(dataSourceId: string | undefined, property: string, name: string): string {
    const schema = (dataSourceId ? this.dataSourceSchemas.get(dataSourceId)?.[property] : undefined) as
      | Record<string, { options?: { name: string }[] } | string>
      | undefined;
    if (!schema || (schema.type !== 'select' && schema.type !== 'multi_select')) return name;
    const config = (schema[schema.type] ??= {}) as { options?: { name: string }[] };
    const options = (config.options ??= []);
    const existing = options.find((option) => option.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.name;
    options.push({ name });
    return name;
  }

  /** Request property values → response property values (as Notion stores them). */
  private toResponseProperties(properties: Args, dataSourceId: string | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      if ('title' in value) out[name] = { id: name, type: 'title', title: richTextResponse(joinRequestText(value.title)) };
      else if ('rich_text' in value) {
        out[name] = {
          id: name,
          type: 'rich_text',
          rich_text: value.rich_text.map((item: { text: { content: string } }) => richTextResponse(item.text.content)[0]),
        };
      } else if ('multi_select' in value) {
        out[name] = {
          id: name,
          type: 'multi_select',
          multi_select: value.multi_select.map((option: { name: string }) => ({
            id: 'o',
            name: this.optionName(dataSourceId, name, option.name),
            color: 'default',
          })),
        };
      } else if ('select' in value) {
        out[name] = {
          id: name,
          type: 'select',
          select: value.select && { id: 'o', name: this.optionName(dataSourceId, name, value.select.name), color: 'default' },
        };
      }
    }
    return out;
  }
}

function sameId(a: string, b: string): boolean {
  return a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase();
}

function blockText(block: { type: string; paragraph: { rich_text: { text: { content: string } }[] } }) {
  return { type: block.type, text: joinRequestText(block.paragraph.rich_text) };
}

/** Evaluates the subset of Notion filters the connector sends. */
function matches(page: PageObjectResponse, filter: Args): boolean {
  if (filter.and) return filter.and.every((condition: Args) => matches(page, condition));
  const property = page.properties[filter.property] as any;
  if (filter.title) {
    const text = property.title.map((item: { plain_text: string }) => item.plain_text).join('');
    return text.toLowerCase().includes(String(filter.title.contains).toLowerCase());
  }
  if (filter.select) return property.select?.name === filter.select.equals;
  if (filter.multi_select) {
    return property.multi_select.some((option: { name: string }) => option.name === filter.multi_select.contains);
  }
  throw new Error(`unsupported filter ${JSON.stringify(filter)}`);
}
