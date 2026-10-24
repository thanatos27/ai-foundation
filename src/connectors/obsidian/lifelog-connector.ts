import type { LifeLog, LifeLogAppendInput, LifeLogCreateInput, LifeLogDocument } from '../../domain/index.js';
import { ConfigurationError } from '../../errors.js';
import type { LifeLogConnector } from '../types.js';
import { formatLifeLogId, lifeLogFileName, parseLifeLogFileName, parseLifeLogId } from './lifelog-id.js';
import type { LifeLogStorage } from './lifelog-storage.js';
import { appendText, normalizeBody } from './text.js';

export interface ObsidianLifeLogConnectorOptions {
  /** `sources.lifelog.obsidian.directory`: vault-relative, `/`-separated. */
  directory: string | undefined;
  storage: LifeLogStorage;
}

/**
 * Life log connector for an Obsidian vault: one free-form Markdown file per article, named
 * `YYYY-MM-DD-<title>.md` directly in the life log directory. Works on file names and text only;
 * the storage does all file access. No frontmatter, heading or date is added to the text.
 */
export class ObsidianLifeLogConnector implements LifeLogConnector {
  constructor(private readonly options: ObsidianLifeLogConnectorOptions) {}

  async create(input: LifeLogCreateInput): Promise<LifeLog> {
    this.directory();
    const name = lifeLogFileName(input.date, input.title);
    await this.options.storage.createExclusive(name, normalizeBody(input.content));
    return this.toLifeLog(name);
  }

  async get(id: string): Promise<LifeLogDocument> {
    const name = parseLifeLogId(id);
    this.directory();
    const file = await this.options.storage.read(name);
    return { lifelog: this.toLifeLog(name), content: file.text };
  }

  async append(input: LifeLogAppendInput): Promise<LifeLog> {
    const name = parseLifeLogId(input.id);
    this.directory();
    // Read first: the file must exist and be valid UTF-8, and its ending decides the separator.
    const file = await this.options.storage.read(name);
    await this.options.storage.append(name, appendText(file.text, input.content));
    return this.toLifeLog(name);
  }

  private directory(): string {
    if (!this.options.directory) throw new ConfigurationError('sources.lifelog.obsidian.directory is not set');
    return this.options.directory;
  }

  private toLifeLog(name: string): LifeLog {
    const { date, title } = parseLifeLogFileName(name)!;
    return {
      id: formatLifeLogId(name),
      type: 'lifelog',
      date,
      title,
      source: 'obsidian',
      external_ref: this.options.storage.refOf(name),
    };
  }
}
