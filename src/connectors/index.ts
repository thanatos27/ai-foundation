import type { Config } from '../config/schema.js';
import type { CredentialProvider } from '../credentials/types.js';
import { lazyGitHubClient } from './github/client.js';
import { GitHubProjectConnector } from './github/connector.js';
import { lazyCalendarApi } from './google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from './google-calendar/connector.js';
import { NotionAreaConnector } from './notion/area-connector.js';
import { lazyNotionClient } from './notion/client.js';
import { NotionCollectionConnector } from './notion/connector.js';
import { ObsidianKnowledgeConnector } from './obsidian/connector.js';
import { FilesystemLifeLogStorage } from './obsidian/filesystem-lifelog-storage.js';
import { FilesystemVaultStorage } from './obsidian/filesystem-storage.js';
import { ObsidianLifeLogConnector } from './obsidian/lifelog-connector.js';
import { lazyTodoistClient } from './todoist/client.js';
import { TodoistTaskConnector } from './todoist/connector.js';
import type { Connectors } from './types.js';

/** The Obsidian connector, reaching the vault the way `storage` says (Phase 4: the file system only). */
function knowledgeConnector(config: Config): ObsidianKnowledgeConnector {
  const obsidian = config.sources.knowledge.obsidian;
  const knowledgeDir = obsidian?.knowledge_dir;
  return new ObsidianKnowledgeConnector({
    knowledgeDir,
    storage: new FilesystemVaultStorage({
      vaultPath: obsidian?.vault_path,
      knowledgeDir,
      lifeLogDir: config.sources.lifelog?.obsidian?.directory,
    }),
  });
}

/** The life log connector: articles in a directory of the knowledge vault (the file system only). */
function lifeLogConnector(config: Config): ObsidianLifeLogConnector {
  const directory = config.sources.lifelog?.obsidian?.directory;
  const obsidian = config.sources.knowledge.obsidian;
  return new ObsidianLifeLogConnector({
    directory,
    storage: new FilesystemLifeLogStorage({
      vaultPath: obsidian?.vault_path,
      directory,
      knowledgeDir: obsidian?.knowledge_dir,
    }),
  });
}

/**
 * Builds the connectors selected in the config. Nothing is contacted and no file is read here:
 * credentials are read, API clients created and the vault checked on the first tool call.
 */
export function createConnectors(config: Config, credentials: CredentialProvider): Connectors {
  const timeZone = config.defaults.timezone;
  // One Notion client for the collection and the areas: same token, same workspace.
  const notion = lazyNotionClient(credentials);
  return {
    task: new TodoistTaskConnector({ client: lazyTodoistClient(credentials), timeZone }),
    schedule: new GoogleCalendarScheduleConnector({
      api: lazyCalendarApi(credentials),
      writableCalendarId: config.sources.schedule.writable_calendar_id,
      timeZone,
    }),
    collection: new NotionCollectionConnector({
      client: notion,
      dataSourceId: config.sources.collection.data_source_id,
    }),
    knowledge: knowledgeConnector(config),
    project: new GitHubProjectConnector({ client: lazyGitHubClient(credentials) }),
    area: new NotionAreaConnector({ client: notion, parentPageId: config.sources.area?.notion?.parent_page_id }),
    lifelog: lifeLogConnector(config),
  };
}
