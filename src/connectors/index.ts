import type { Config } from '../config/schema.js';
import type { CredentialProvider } from '../credentials/types.js';
import { lazyCalendarApi } from './google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from './google-calendar/connector.js';
import { lazyNotionClient } from './notion/client.js';
import { NotionCollectionConnector } from './notion/connector.js';
import { ObsidianKnowledgeConnector } from './obsidian/connector.js';
import { FilesystemVaultStorage } from './obsidian/filesystem-storage.js';
import { lazyTodoistClient } from './todoist/client.js';
import { TodoistTaskConnector } from './todoist/connector.js';
import type { Connectors } from './types.js';

/** The Obsidian connector, reaching the vault the way `storage` says (Phase 4: the file system only). */
function knowledgeConnector(config: Config): ObsidianKnowledgeConnector {
  const obsidian = config.sources.knowledge.obsidian;
  const knowledgeDir = obsidian?.knowledge_dir;
  return new ObsidianKnowledgeConnector({
    knowledgeDir,
    storage: new FilesystemVaultStorage({ vaultPath: obsidian?.vault_path, knowledgeDir }),
  });
}

/**
 * Builds the connectors selected in the config. Nothing is contacted and no file is read here:
 * credentials are read, API clients created and the vault checked on the first tool call.
 */
export function createConnectors(config: Config, credentials: CredentialProvider): Connectors {
  const timeZone = config.defaults.timezone;
  return {
    task: new TodoistTaskConnector({ client: lazyTodoistClient(credentials), timeZone }),
    schedule: new GoogleCalendarScheduleConnector({
      api: lazyCalendarApi(credentials),
      writableCalendarId: config.sources.schedule.writable_calendar_id,
      timeZone,
    }),
    collection: new NotionCollectionConnector({
      client: lazyNotionClient(credentials),
      dataSourceId: config.sources.collection.data_source_id,
    }),
    knowledge: knowledgeConnector(config),
  };
}
