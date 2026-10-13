import type { Schedule, ScheduleCreateInput, ScheduleListFilter } from '../../domain/index.js';
import { normalizeScheduleCreateInput } from '../../domain/index.js';
import { ConfigurationError, ProviderApiError } from '../../errors.js';
import type { ScheduleConnector } from '../types.js';
import { type CalendarApi, toFoundationError } from './client.js';
import { startInstant, toGoogleEvent, toSchedule, toTimeRange } from './mapping.js';

export interface GoogleCalendarScheduleConnectorOptions {
  /** Resolves the API client; called on every operation (memoize it). */
  api: () => Promise<CalendarApi>;
  /** `sources.schedule.writable_calendar_id`: the only calendar this connector writes to. */
  writableCalendarId: string | undefined;
  /** Zone for date-only periods (`defaults.timezone`). */
  timeZone: string;
}

/** Schedule connector for Google Calendar. Reads every readable calendar, writes to one. */
export class GoogleCalendarScheduleConnector implements ScheduleConnector {
  constructor(private readonly options: GoogleCalendarScheduleConnectorOptions) {}

  async create(input: ScheduleCreateInput): Promise<Schedule> {
    // The write target comes from configuration only; no input reaches `calendarId`.
    const calendarId = this.options.writableCalendarId;
    if (!calendarId) {
      throw new ConfigurationError(
        'sources.schedule.writable_calendar_id is not set; schedule_create needs the AI Foundation calendar ID',
      );
    }
    const api = await this.options.api();
    const created = await api.insertEvent(calendarId, toGoogleEvent(normalizeScheduleCreateInput(input))).catch(
      (error: unknown) => {
        throw toFoundationError(error, {
          notFound: () =>
            new ConfigurationError(
              `writable_calendar_id ${calendarId} was not found or is not accessible with these credentials`,
              { cause: error },
            ),
        });
      },
    );
    const schedule = toSchedule(created, calendarId);
    if (!schedule) throw new ProviderApiError('Google Calendar', 'the created event has no start');
    return schedule;
  }

  async list(filter: ScheduleListFilter): Promise<Schedule[]> {
    const range = toTimeRange(filter, this.options.timeZone);
    const api = await this.options.api();
    const calendars = await api.listCalendars().catch((error: unknown) => {
      throw toFoundationError(error);
    });

    // A failing calendar fails the whole call: a partial list would read as "no events".
    const perCalendar = await Promise.all(
      calendars
        .filter((entry): entry is typeof entry & { id: string } => !!entry.id)
        .map(async (entry) => {
          const events = await api.listEvents(entry.id, range).catch((error: unknown) => {
            throw toFoundationError(error, { context: `calendar "${entry.summary ?? entry.id}"` });
          });
          return events
            .filter((event) => event.status !== 'cancelled')
            .map((event) => toSchedule(event, entry.id))
            .filter((schedule): schedule is Schedule => schedule !== undefined);
        }),
    );

    const { timeZone } = this.options;
    return perCalendar
      .flat()
      .sort((a, b) => startInstant(a, timeZone) - startInstant(b, timeZone) || a.title.localeCompare(b.title));
  }
}
