import type { Config } from '../config/schema.js';
import type { CredentialProvider } from '../credentials/types.js';
import { lazyGitHubClient } from './github/client.js';
import { GitHubProjectConnector } from './github/connector.js';
import { lazyCalendarApi } from './google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from './google-calendar/connector.js';
import { NotionAreaConnector } from './notion/area-connector.js';
import { lazyNotionClient } from './notion/client.js';
import { NotionCollectionConnector } from './notion/connector.js';
import { lazyDriveApi } from './google-drive/client.js';
import { ObsidianKnowledgeConnector } from './obsidian/connector.js';
import { DriveCreateLock } from './obsidian/drive-create-lock.js';
import { DriveLifeLogStorage } from './obsidian/drive-lifelog-storage.js';
import { DriveVaultStorage } from './obsidian/drive-storage.js';
import { FilesystemLifeLogStorage } from './obsidian/filesystem-lifelog-storage.js';
import { FilesystemVaultStorage } from './obsidian/filesystem-storage.js';
import { ObsidianLifeLogConnector } from './obsidian/lifelog-connector.js';
import type { LifeLogStorage } from './obsidian/lifelog-storage.js';
import type { VaultStorage } from './obsidian/storage.js';
import { lazyTodoistClient } from './todoist/client.js';
import { TodoistTaskConnector } from './todoist/connector.js';
import type { Connectors } from './types.js';

/**
 * The knowledge and life log storages, reaching the vault the way `sources.knowledge.obsidian.storage`
 * says. Life logs always live in the knowledge vault, so both use the same storage. Without the
 * block, the file system storage reports the missing vault on the first call.
 */
function vaultStorages(config: Config, credentials: CredentialProvider): { knowledge: VaultStorage; lifelog: LifeLogStorage } {
  const obsidian = config.sources.knowledge.obsidian;
  const knowledgeDir = obsidian?.knowledge_dir;
  const lifeLogDir = config.sources.lifelog?.obsidian?.directory;
  if (obsidian?.storage === 'google_drive') {
    // One client and one create lock for both: same credentials, same vault.
    const api = lazyDriveApi(credentials);
    const createLock = new DriveCreateLock();
    const vaultFolderId = obsidian.vault_folder_id;
    return {
      knowledge: new DriveVaultStorage({ api, vaultFolderId, knowledgeDir, lifeLogDir, createLock }),
      lifelog: new DriveLifeLogStorage({ api, vaultFolderId, directory: lifeLogDir, knowledgeDir, createLock }),
    };
  }
  const vaultPath = obsidian?.vault_path;
  return {
    knowledge: new FilesystemVaultStorage({ vaultPath, knowledgeDir, lifeLogDir }),
    lifelog: new FilesystemLifeLogStorage({ vaultPath, directory: lifeLogDir, knowledgeDir }),
  };
}

/**
 * Builds the connectors selected in the config. Nothing is contacted and no file is read here:
 * credentials are read, API clients created and the vault checked on the first tool call.
 */
export function createConnectors(config: Config, credentials: CredentialProvider): Connectors {
  const timeZone = config.defaults.timezone;
  // One Notion client for the collection and the areas: same token, same workspace.
  const notion = lazyNotionClient(credentials);
  const storages = vaultStorages(config, credentials);
  return {
    task: new TodoistTaskConnector({ client: lazyTodoistClient(credentials), timeZone }),
    schedule: new GoogleCalendarScheduleConnector({
      api: lazyCalendarApi(credentials),
      writableCalendars: config.sources.schedule.writable_calendars,
      defaultCalendar: config.sources.schedule.default_calendar,
      timeZone,
    }),
    collection: new NotionCollectionConnector({
      client: notion,
      dataSourceId: config.sources.collection.data_source_id,
    }),
    knowledge: new ObsidianKnowledgeConnector({
      knowledgeDir: config.sources.knowledge.obsidian?.knowledge_dir,
      storage: storages.knowledge,
    }),
    project: new GitHubProjectConnector({ client: lazyGitHubClient(credentials) }),
    area: new NotionAreaConnector({ client: notion, parentPageId: config.sources.area?.notion?.parent_page_id }),
    lifelog: new ObsidianLifeLogConnector({
      directory: config.sources.lifelog?.obsidian?.directory,
      storage: storages.lifelog,
    }),
  };
}
