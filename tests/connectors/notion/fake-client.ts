import { APIErrorCode, APIResponseError, type PageObjectResponse } from '@notionhq/client';
import type { NotionClient } from '../../../src/connectors/notion/client.js';

export const DATA_SOURCE_ID = '11111111-2222-3333-4444-555555555555';
export const OTHER_DATA_SOURCE_ID = '99999999-8888-7777-6666-555555555555';

export const COLLECTION_PROPERTIES: Record<string, { type: string }> = {
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
  | 'blocks.children.append';

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
  dataSourceSchemas = new Map<string, Record<string, { type: string }>>([[DATA_SOURCE_ID, COLLECTION_PROPERTIES]]);
  readonly storedPages = new Map<string, PageObjectResponse>();
  /** Page ID → its paragraphs, in order. */
  readonly storedBlocks = new Map<string, { type: string; text: string }[]>();
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
      const page = this.pageObject(id, this.toResponseProperties(args.properties), { parentDataSourceId: dataSourceId });
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
      Object.assign(page.properties, this.toResponseProperties(args.properties ?? {}));
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

  /** Request property values → response property values (as Notion stores them). */
  private toResponseProperties(properties: Args): Record<string, unknown> {
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
          multi_select: value.multi_select.map((option: { name: string }) => ({ id: 'o', name: option.name, color: 'default' })),
        };
      } else if ('select' in value) {
        out[name] = { id: name, type: 'select', select: value.select && { id: 'o', name: value.select.name, color: 'default' } };
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
