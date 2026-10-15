import {
  isFullDataSource,
  isFullPage,
  type PageObjectResponse,
  type QueryDataSourceResponse,
  type UpdatePageParameters,
} from '@notionhq/client';
import {
  type CollectionCreateInput,
  type CollectionItem,
  type CollectionSearchFilter,
  type CollectionUpdateInput,
  mergeMetadata,
} from '../../domain/index.js';
import { ConfigurationError, NotFoundError, ProviderApiError } from '../../errors.js';
import type { CollectionConnector } from '../types.js';
import { type NotionClient, toFoundationError } from './client.js';
import { canMatch, toQueryFilter } from './filter.js';
import {
  assertRequestSize,
  collectionTypeOf,
  metadataRichText,
  paragraph,
  parseCollectionId,
  readMetadata,
  richText,
  sameNotionId,
  selectOption,
  tagOptions,
  toCollectionItem,
} from './mapping.js';
import { PROPERTY, schemaProblems } from './schema.js';

const PAGE_SIZE = 100;

export interface NotionCollectionConnectorOptions {
  /** Resolves the SDK client; called on every operation (memoize it). */
  client: () => Promise<NotionClient>;
  /** `sources.collection.data_source_id`: the only data source read from and written to. */
  dataSourceId: string | undefined;
  /** Where to report pages left out of search results. Defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Collection connector for Notion. Every item lives in the configured data source: items are created
 * there, searched there, and only pages whose parent is that data source can be updated.
 */
export class NotionCollectionConnector implements CollectionConnector {
  private schemaCheck: Promise<void> | undefined;

  constructor(private readonly options: NotionCollectionConnectorOptions) {}

  async create(input: CollectionCreateInput): Promise<CollectionItem> {
    const dataSourceId = this.dataSourceId();
    const body = {
      parent: { type: 'data_source_id' as const, data_source_id: dataSourceId },
      properties: {
        [PROPERTY.title]: { title: richText(input.title, 'title') },
        [PROPERTY.collectionType]: { select: { name: input.collection_type } },
        [PROPERTY.status]: { select: selectOption(input.status, 'status') },
        [PROPERTY.tags]: { multi_select: tagOptions(input.tags ?? []) },
        [PROPERTY.metadata]: { rich_text: input.metadata ? metadataRichText(input.metadata) : [] },
      },
      // Sent with the page so the page and its note are created together.
      ...(input.note != null ? { children: [paragraph(input.note, 'note')] } : {}),
    };
    assertRequestSize(body, 'title, metadata, note and tags');

    const api = await this.ready(dataSourceId);
    const created = await api.pages.create(body).catch((error: unknown) => {
      throw toFoundationError(error, { notFound: () => this.dataSourceNotFound(dataSourceId, error) });
    });
    return this.toItem(await this.fullPage(api, created, created.id));
  }

  async search(filter: CollectionSearchFilter): Promise<CollectionItem[]> {
    const dataSourceId = this.dataSourceId();
    const api = await this.ready(dataSourceId);
    if (!canMatch(filter)) return [];

    const queryFilter = toQueryFilter(filter);
    const pages: PageObjectResponse[] = [];
    let cursor: string | undefined;
    do {
      const response: QueryDataSourceResponse = await api.dataSources
        .query({
          data_source_id: dataSourceId,
          ...(queryFilter ? { filter: queryFilter } : {}),
          sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
          page_size: PAGE_SIZE,
          result_type: 'page',
          ...(cursor ? { start_cursor: cursor } : {}),
        })
        .catch((error: unknown) => {
          throw toFoundationError(error, { notFound: () => this.dataSourceNotFound(dataSourceId, error) });
        });
      if (response.request_status?.type === 'incomplete') {
        // Never return a silently truncated result.
        throw new ProviderApiError(
          'Notion',
          `the search result is incomplete (${response.request_status.incomplete_reason ?? 'unknown reason'}); narrow the filter`,
        );
      }
      for (const result of response.results) {
        if (result.object === 'page' && isFullPage(result) && !result.in_trash) pages.push(result);
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    const items: CollectionItem[] = [];
    let skipped = 0;
    for (const page of pages) {
      const collectionType = collectionTypeOf(page);
      if (collectionType) items.push(toCollectionItem(page, collectionType));
      else skipped += 1;
    }
    if (skipped > 0) {
      this.warn(`collection_search skipped ${skipped} Notion page(s) whose Type is empty or not game/book/movie/other`);
    }
    return items;
  }

  /**
   * Checks the page and every input before writing anything; then updates the properties and
   * appends the note, in that order. The two writes are separate requests: if the note fails after
   * the properties were updated, the error says so, so that only the note needs to be sent again.
   */
  async update(input: CollectionUpdateInput): Promise<CollectionItem> {
    const pageId = parseCollectionId(input.id);
    const dataSourceId = this.dataSourceId();
    const api = await this.ready(dataSourceId);
    const page = await this.collectionPage(api, input.id, pageId, dataSourceId);

    if (!collectionTypeOf(page)) {
      throw new ProviderApiError(
        'Notion',
        `collection item ${input.id} has no valid Type (game, book, movie or other); set it in Notion first`,
      );
    }

    const properties: NonNullable<UpdatePageParameters['properties']> = {};
    if (input.status !== undefined) {
      properties[PROPERTY.status] = { select: input.status === null ? null : selectOption(input.status, 'status') };
    }
    if (input.tags !== undefined) properties[PROPERTY.tags] = { multi_select: tagOptions(input.tags) };
    if (input.metadata !== undefined) {
      const current = readMetadata(page);
      if (!current) {
        // Merging into {} would silently erase what is in Notion.
        throw new ProviderApiError(
          'Notion',
          `the Metadata of collection item ${input.id} is not a JSON object; fix it in Notion before updating metadata`,
        );
      }
      properties[PROPERTY.metadata] = { rich_text: metadataRichText(mergeMetadata(current, input.metadata)) };
    }
    const updateBody = Object.keys(properties).length > 0 ? { properties } : undefined;
    const appendBody =
      input.append_note != null
        ? { children: [paragraph(input.append_note, 'append_note')], position: { type: 'end' as const } }
        : undefined;
    if (updateBody) assertRequestSize(updateBody, 'status, metadata and tags');
    if (appendBody) assertRequestSize(appendBody, 'append_note');

    let updated = page;
    if (updateBody) {
      const response = await api.pages
        .update({ page_id: pageId, ...updateBody })
        .catch((error: unknown) => {
          throw toFoundationError(error, { notFound: () => this.itemNotFound(input.id, error) });
        });
      updated = await this.fullPage(api, response, pageId);
    }

    if (appendBody) {
      await api.blocks.children.append({ block_id: pageId, ...appendBody }).catch((error: unknown) => {
        const cause = toFoundationError(error, { notFound: () => this.itemNotFound(input.id, error) });
        if (!updateBody) throw cause;
        throw new ProviderApiError(
          'Notion',
          `the properties of collection item ${input.id} were updated, but the note could not be appended: ${cause.message}`,
          { cause },
        );
      });
    }
    return this.toItem(updated);
  }

  private dataSourceId(): string {
    const id = this.options.dataSourceId;
    if (!id) throw new ConfigurationError('sources.collection.data_source_id is not set');
    return id;
  }

  /** The client, once the data source has been checked against the collection schema (once per process). */
  private async ready(dataSourceId: string): Promise<NotionClient> {
    const api = await this.options.client();
    this.schemaCheck ??= this.checkSchema(api, dataSourceId);
    // Check again on the next call if it failed (e.g. after fixing the data source in Notion).
    this.schemaCheck.catch(() => (this.schemaCheck = undefined));
    await this.schemaCheck;
    return api;
  }

  private async checkSchema(api: NotionClient, dataSourceId: string): Promise<void> {
    const dataSource = await api.dataSources.retrieve({ data_source_id: dataSourceId }).catch((error: unknown) => {
      throw toFoundationError(error, { notFound: () => this.dataSourceNotFound(dataSourceId, error) });
    });
    if (!isFullDataSource(dataSource)) {
      throw new ConfigurationError(`the schema of Notion data source ${dataSourceId} could not be read`);
    }
    const problems = schemaProblems(dataSource.properties);
    if (problems.length > 0) {
      throw new ConfigurationError(
        `Notion data source ${dataSourceId} does not match the Collection schema: ${problems.join('; ')}`,
      );
    }
  }

  /** The page behind `id`, provided it is a live page of the collection data source. */
  private async collectionPage(
    api: NotionClient,
    id: string,
    pageId: string,
    dataSourceId: string,
  ): Promise<PageObjectResponse> {
    const page = await api.pages.retrieve({ page_id: pageId }).catch((error: unknown) => {
      throw toFoundationError(error, { notFound: () => this.itemNotFound(id, error) });
    });
    const inCollection =
      isFullPage(page) &&
      !page.in_trash &&
      page.parent.type === 'data_source_id' &&
      sameNotionId(page.parent.data_source_id, dataSourceId);
    // A page outside the collection is reported as missing rather than revealed.
    if (!inCollection) throw this.itemNotFound(id);
    return page;
  }

  /** Write responses can be partial objects; read the page back in that case. */
  private async fullPage(
    api: NotionClient,
    response: { object: string; id: string },
    pageId: string,
  ): Promise<PageObjectResponse> {
    if (isFullPage(response as PageObjectResponse)) return response as PageObjectResponse;
    const page = await api.pages.retrieve({ page_id: pageId }).catch((error: unknown) => {
      throw toFoundationError(error);
    });
    if (!isFullPage(page)) throw new ProviderApiError('Notion', `page ${pageId} could not be read back`);
    return page;
  }

  private toItem(page: PageObjectResponse): CollectionItem {
    const collectionType = collectionTypeOf(page);
    if (!collectionType) {
      throw new ProviderApiError('Notion', `page ${page.id} has no valid Type (game, book, movie or other)`);
    }
    return toCollectionItem(page, collectionType);
  }

  private itemNotFound(id: string, cause?: unknown): NotFoundError {
    return new NotFoundError(`collection item ${id}`, { cause });
  }

  private dataSourceNotFound(dataSourceId: string, cause: unknown): ConfigurationError {
    return new ConfigurationError(
      `Notion data source ${dataSourceId} was not found or is not shared with the AI Foundation connection`,
      { cause },
    );
  }

  private warn(message: string): void {
    (this.options.warn ?? ((text: string) => console.error(`[ai-foundation] ${text}`)))(message);
  }
}
