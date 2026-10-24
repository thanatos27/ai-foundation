import type { Schedule, ScheduleCreateInput, ScheduleListFilter, ScheduleUpdateInput } from '../../domain/index.js';
import { normalizeScheduleCreateInput } from '../../domain/index.js';
import { ConfigurationError, InputValidationError, NotFoundError, ProviderApiError } from '../../errors.js';
import type { ScheduleConnector } from '../types.js';
import { WritableCalendars } from './calendars.js';
import { type CalendarApi, type GoogleEvent, toFoundationError } from './client.js';
import { parseScheduleId, startInstant, toEventPatch, toGoogleEvent, toSchedule, toTimeRange } from './mapping.js';

export interface GoogleCalendarScheduleConnectorOptions {
  /** Resolves the API client; called on every operation (memoize it). */
  api: () => Promise<CalendarApi>;
  /** `sources.schedule.writable_calendars`: alias → calendar ID, the only calendars this connector writes to. */
  writableCalendars: Record<string, string> | undefined;
  /** `sources.schedule.default_calendar`: the alias schedule_create uses when none is given. */
  defaultCalendar: string | undefined;
  /** Zone for date-only periods (`defaults.timezone`). */
  timeZone: string;
}

/** Schedule connector for Google Calendar. Reads every readable calendar, writes to the configured ones. */
export class GoogleCalendarScheduleConnector implements ScheduleConnector {
  private readonly calendars: WritableCalendars;

  constructor(private readonly options: GoogleCalendarScheduleConnectorOptions) {
    this.calendars = new WritableCalendars(options.writableCalendars, options.defaultCalendar);
  }

  async create(input: ScheduleCreateInput): Promise<Schedule> {
    // The write target comes from configuration only: the input names it by alias.
    const { alias, calendarId } = this.calendars.forCreate(input.calendar);
    const api = await this.options.api();
    const created = await api
      .insertEvent(calendarId, toGoogleEvent(normalizeScheduleCreateInput(input)))
      .catch((error: unknown) => {
        throw toFoundationError(error, this.writeErrors(alias, error));
      });
    const schedule = toSchedule(created, calendarId, alias);
    if (!schedule) throw new ProviderApiError('Google Calendar', 'the created event has no start');
    return schedule;
  }

  async list(filter: ScheduleListFilter): Promise<Schedule[]> {
    const range = toTimeRange(filter, this.options.timeZone);
    const api = await this.options.api();
    const calendars = await api.listCalendars().catch((error: unknown) => {
      throw toFoundationError(error);
    });
    const wanted = filter.calendar === undefined ? undefined : this.calendars.resolveForList(filter.calendar);
    const targets = calendars.filter(
      (entry): entry is typeof entry & { id: string } => !!entry.id && (wanted === undefined || entry.id === wanted),
    );
    if (wanted !== undefined && targets.length === 0) {
      throw new InputValidationError(
        `calendar "${filter.calendar}" is neither a configured calendar (${this.calendars.names() || 'none'}) ` +
          `nor a calendar you can read`,
      );
    }

    // A failing calendar fails the whole call: a partial list would read as "no events".
    const perCalendar = await Promise.all(
      targets.map(async (entry) => {
        const events = await api.listEvents(entry.id, range).catch((error: unknown) => {
          throw toFoundationError(error, { context: `calendar "${entry.summary ?? entry.id}"` });
        });
        const label = this.calendars.label(entry.id);
        return events
          .filter((event) => event.status !== 'cancelled')
          .map((event) => toSchedule(event, entry.id, label))
          .filter((schedule): schedule is Schedule => schedule !== undefined);
      }),
    );

    const { timeZone } = this.options;
    return perCalendar
      .flat()
      .sort((a, b) => startInstant(a, timeZone) - startInstant(b, timeZone) || a.title.localeCompare(b.title));
  }

  async update(input: ScheduleUpdateInput): Promise<Schedule> {
    this.calendars.requireConfigured('schedule_update');
    const { calendarId, eventId } = parseScheduleId(input.id);
    // Checked before any API call: the id is input, so its calendar must be a configured one.
    const alias = this.calendars.aliasOf(calendarId);
    if (alias === undefined) {
      throw new InputValidationError(
        `schedule ${input.id} is on a calendar AI Foundation does not write to; ` +
          `writable calendars: ${this.calendars.names()}`,
      );
    }
    const notFound = (cause?: unknown) => new NotFoundError(`schedule ${input.id}`, { cause });

    const api = await this.options.api();
    const current = await api.getEvent(calendarId, eventId).catch((error: unknown) => {
      throw toFoundationError(error, { notFound: () => notFound(error) });
    });
    if (current.status === 'cancelled') throw notFound();
    rejectUnsupported(current, calendarId);

    const updated = await api
      .patchEvent(calendarId, eventId, toEventPatch(input, current))
      .catch((error: unknown) => {
        throw toFoundationError(error, { ...this.writeErrors(alias, error), notFound: () => notFound(error) });
      });
    const schedule = toSchedule(updated, calendarId, alias);
    if (!schedule) throw new ProviderApiError('Google Calendar', 'the updated event has no start');
    return schedule;
  }

  /** A configured calendar that does not exist or may not be written is a configuration problem. */
  private writeErrors(alias: string, error: unknown) {
    return {
      notFound: () =>
        new ConfigurationError(
          `writable calendar "${alias}" was not found or is not accessible with these credentials`,
          { cause: error },
        ),
      forbidden: () =>
        new ConfigurationError(`writable calendar "${alias}" is not writable with these credentials`, {
          cause: error,
        }),
    };
  }
}

/** Events schedule_update leaves alone (MVP: single events the calendar itself organizes). */
function rejectUnsupported(event: GoogleEvent, calendarId: string): void {
  if (event.recurrence?.length || event.recurringEventId) {
    throw new InputValidationError('recurring events cannot be updated yet; change them in Google Calendar');
  }
  if (event.eventType && event.eventType !== 'default') {
    throw new InputValidationError(`${event.eventType} events cannot be updated; change them in Google Calendar`);
  }
  if (event.organizer && event.organizer.self !== true && event.organizer.email !== calendarId) {
    throw new InputValidationError('events organized by someone else cannot be updated');
  }
}
