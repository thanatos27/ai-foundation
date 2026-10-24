import { ConfigurationError, InputValidationError } from '../../errors.js';

/**
 * The configured writable calendars (`sources.schedule.writable_calendars`), by alias.
 * Tool input names a write target only through an alias: no input is ever used as a calendar ID
 * to write to. Error messages list aliases only, never calendar IDs.
 */
export class WritableCalendars {
  private readonly byAlias: ReadonlyMap<string, string>;
  private readonly byId: ReadonlyMap<string, string>;

  constructor(
    aliases: Record<string, string> | undefined,
    private readonly defaultAlias: string | undefined,
  ) {
    this.byAlias = new Map(Object.entries(aliases ?? {}));
    this.byId = new Map([...this.byAlias].map(([alias, id]) => [id, alias]));
  }

  /** `schedule_create`: the alias (or the default) and its calendar ID. */
  forCreate(alias: string | undefined): { alias: string; calendarId: string } {
    const name = alias ?? this.defaultAlias;
    this.requireConfigured('schedule_create');
    const calendarId = name === undefined ? undefined : this.byAlias.get(name);
    if (name === undefined || calendarId === undefined) {
      throw new InputValidationError(`calendar must be one of the configured calendars: ${this.names()} (got "${alias}")`);
    }
    return { alias: name, calendarId };
  }

  /** `schedule_update`: the alias of a calendar ID taken from a schedule id, if it is writable. */
  aliasOf(calendarId: string): string | undefined {
    return this.byId.get(calendarId);
  }

  /** `schedule_list`: an alias becomes its calendar ID; anything else is taken as a calendar ID. */
  resolveForList(calendar: string): string {
    return this.byAlias.get(calendar) ?? calendar;
  }

  /** `Schedule.calendar`: the alias of a writable calendar, the calendar ID otherwise. */
  label(calendarId: string): string {
    return this.byId.get(calendarId) ?? calendarId;
  }

  /** Configured aliases for messages, e.g. `personal, events`. */
  names(): string {
    return [...this.byAlias.keys()].join(', ');
  }

  requireConfigured(tool: string): void {
    if (this.byAlias.size === 0) {
      throw new ConfigurationError(
        `sources.schedule.writable_calendars is not set; ${tool} needs at least one writable calendar`,
      );
    }
  }
}
