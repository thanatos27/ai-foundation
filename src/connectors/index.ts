import type { Config } from '../config/schema.js';
import type { CredentialProvider } from '../credentials/types.js';
import { lazyCalendarApi } from './google-calendar/client.js';
import { GoogleCalendarScheduleConnector } from './google-calendar/connector.js';
import { lazyTodoistClient } from './todoist/client.js';
import { TodoistTaskConnector } from './todoist/connector.js';
import type { Connectors } from './types.js';

/**
 * Builds the connectors selected in the config. Nothing is contacted here: credentials are read
 * and API clients created on the first tool call.
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
  };
}
