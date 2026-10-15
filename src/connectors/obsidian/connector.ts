import type {
  Knowledge,
  KnowledgeAppendInput,
  KnowledgeDocument,
  KnowledgeSearchFilter,
  KnowledgeSearchResult,
} from '../../domain/index.js';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../errors.js';
import type { KnowledgeConnector, KnowledgeCreate } from '../types.js';
import { toFileName } from './filename.js';
import { fileTitle, formatKnowledgeId, parseKnowledgeId, quoteId, type VaultPath, vaultPathBelow } from './id.js';
import { appendText, createFileText, type KnowledgeMeta, parseKnowledgeFile } from './markdown.js';
import { matches, snippet } from './search.js';
import type { VaultFile, VaultStorage } from './storage.js';
import { invalidTag } from './tags.js';

/** Files read at the same time by knowledge_search. */
const READ_CONCURRENCY = 8;
/** Malformed files named in the knowledge_search warning. */
const MAX_REPORTED = 10;

export interface ObsidianKnowledgeConnectorOptions {
  /** `sources.knowledge.obsidian.knowledge_dir`: vault-relative, `/`-separated. */
  knowledgeDir: string | undefined;
  storage: VaultStorage;
  /** Where to report files left out of search results. Defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Knowledge connector for an Obsidian vault: one Markdown file per knowledge, identified by its
 * vault-relative path. Works on vault paths and text only; the storage does all file access.
 */
export class ObsidianKnowledgeConnector implements KnowledgeConnector {
  constructor(private readonly options: ObsidianKnowledgeConnectorOptions) {}

  async create(input: KnowledgeCreate): Promise<Knowledge> {
    const knowledgeDir = this.knowledgeDir();
    assertValidTags(input.tags ?? []);
    const path = vaultPathBelow(knowledgeDir, [toFileName(input.title)]);
    const meta: KnowledgeMeta = {
      title: input.title,
      description: input.description ?? null,
      area: input.area,
      tags: input.tags ?? [],
    };
    await this.options.storage.createExclusive(path, createFileText(meta, input.content));
    return toKnowledge(path, meta);
  }

  async search(filter: KnowledgeSearchFilter): Promise<KnowledgeSearchResult[]> {
    this.knowledgeDir();
    assertValidTags(filter.tags ?? []);
    const entries = await this.options.storage.list();
    const files = await mapLimit(entries, READ_CONCURRENCY, async ({ path }) =>
      this.options.storage.read(path).catch((error: unknown) => {
        if (error instanceof NotFoundError) return undefined; // removed while searching
        throw error;
      }),
    );

    const results: { result: KnowledgeSearchResult; modifiedAt: number }[] = [];
    const malformed: VaultPath[] = [];
    for (const file of files) {
      if (!file) continue;
      const parsed = parseKnowledgeFile(file.text, fileTitle(file.path));
      if (!parsed.ok) {
        malformed.push(file.path);
        continue;
      }
      if (!matches(parsed.meta, parsed.body, filter)) continue;
      results.push({
        result: { ...toKnowledge(file.path, parsed.meta), snippet: snippet(parsed.body, filter.query) },
        modifiedAt: file.modifiedAt,
      });
    }
    if (malformed.length > 0) {
      const shown = malformed.slice(0, MAX_REPORTED).join(', ');
      const more = malformed.length > MAX_REPORTED ? `, and ${malformed.length - MAX_REPORTED} more` : '';
      this.warn(`knowledge_search skipped ${malformed.length} file(s) with malformed frontmatter: ${shown}${more}`);
    }

    // Most recently modified first; the ID breaks ties so the order is stable.
    results.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.result.id! < b.result.id! ? -1 : 1));
    return results.map(({ result }) => result);
  }

  async get(id: string): Promise<KnowledgeDocument> {
    const path = parseKnowledgeId(id, this.knowledgeDir());
    const file = await this.options.storage.read(path);
    const { meta, body } = parseOrThrow(file);
    return { knowledge: toKnowledge(path, meta), content: body };
  }

  async append(input: KnowledgeAppendInput): Promise<Knowledge> {
    const path = parseKnowledgeId(input.id, this.knowledgeDir());
    const file = await this.options.storage.read(path);
    // Checked before writing: a malformed note is never written to.
    const { meta } = parseOrThrow(file);
    await this.options.storage.append(path, appendText(file.text, input.content));
    return toKnowledge(path, meta);
  }

  private knowledgeDir(): string {
    if (!this.options.knowledgeDir) {
      throw new ConfigurationError('sources.knowledge.obsidian.knowledge_dir is not set');
    }
    return this.options.knowledgeDir;
  }

  private warn(message: string): void {
    (this.options.warn ?? ((text: string) => console.error(`[ai-foundation] ${text}`)))(message);
  }
}

function toKnowledge(path: VaultPath, meta: KnowledgeMeta): Knowledge {
  return {
    id: formatKnowledgeId(path),
    type: 'knowledge',
    title: meta.title,
    description: meta.description,
    source: 'obsidian',
    external_ref: path,
    area: meta.area,
    tags: meta.tags,
  };
}

function parseOrThrow(file: VaultFile): { meta: KnowledgeMeta; body: string } {
  const parsed = parseKnowledgeFile(file.text, fileTitle(file.path));
  if (!parsed.ok) {
    throw new ProviderApiError(
      'Obsidian',
      `the frontmatter of ${quoteId(file.path)} is malformed (${parsed.reason}); fix it in Obsidian`,
    );
  }
  return parsed;
}

function assertValidTags(tags: readonly string[]): void {
  const invalid = invalidTag(tags);
  if (invalid) throw new InputValidationError(`tag "${invalid.tag}" is not a valid Obsidian tag: ${invalid.problem}`);
}

/** `Promise.all(items.map(fn))` with at most `limit` calls running at once. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
