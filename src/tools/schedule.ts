import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ScheduleConnector } from '../connectors/types.js';
import {
  ScheduleCreateInputSchema,
  ScheduleListFilterSchema,
  ScheduleSchema,
  ScheduleUpdateInputSchema,
} from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const ScheduleOutputSchema = z.object({ schedule: ScheduleSchema });
const ScheduleListOutputSchema = z.object({ schedules: z.array(ScheduleSchema) });

/** Registers schedule_create / schedule_list / schedule_update (Source of Truth: Google Calendar). */
export function registerScheduleTools(server: McpServer, { config, connectors }: ToolContext): void {
  const timeZone = config.defaults.timezone;
  const { writable_calendars: writableCalendars, default_calendar: defaultCalendar } = config.sources.schedule;
  const aliases = Object.keys(writableCalendars ?? {});
  // Aliases are static configuration, so the tools can name them up front.
  const calendarsText = aliases.length
    ? `Writable calendars: ${aliases.join(', ')} (default: ${defaultCalendar}).`
    : 'No writable calendar is configured.';

  const connector = (): ScheduleConnector => {
    if (!connectors.schedule) throw new ConfigurationError('the schedule source (Google Calendar) is not configured');
    return connectors.schedule;
  };

  server.registerTool(
    'schedule_create',
    {
      title: 'Create schedule',
      description:
        `Create an event or time block on one of the writable Google Calendars configured for AI Foundation ` +
        `(it never writes elsewhere). ${calendarsText} Set calendar to one of these names; omit it for the default. ` +
        `Timed event: start / end are ISO 8601 date-times with an explicit offset; end defaults to one hour after start. ` +
        `All-day event, including an event period such as an exhibition or festival: start / end are "YYYY-MM-DD" ` +
        `and end is the last day, inclusive; end defaults to a single day. ` +
        `Do not mix the two forms. Resolve relative expressions such as "Saturday 14:00" yourself; ` +
        `the user's time zone is ${timeZone}. ` +
        `description is free-form text stored as given (put an official URL or notes there); location is the place. ` +
        `For a deadline without a time block, use task_create instead.`,
      inputSchema: ScheduleCreateInputSchema,
      outputSchema: ScheduleOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => jsonResult({ schedule: await connector().create(input) }),
  );

  server.registerTool(
    'schedule_list',
    {
      title: 'List schedules',
      description:
        `List events overlapping a period across every Google Calendar the user can read, ` +
        `or only one calendar when calendar is given (a writable calendar name, or a calendar value from a result). ` +
        `start / end are "YYYY-MM-DD" (whole days, end inclusive, in ${timeZone}) or ISO 8601 date-times with an offset. ` +
        `Events that started before the period but are still going on are included. ` +
        `All-day events are returned with "YYYY-MM-DD" start / end, end inclusive. ` +
        `description is returned exactly as stored in Google Calendar and may contain HTML; ` +
        `calendar is the writable calendar's name, or the calendar ID for other calendars. ${calendarsText}`,
      inputSchema: ScheduleListFilterSchema,
      outputSchema: ScheduleListOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (filter) => jsonResult({ schedules: await connector().list(filter) }),
  );

  server.registerTool(
    'schedule_update',
    {
      title: 'Update schedule',
      description:
        `Update a single event on a writable calendar, by the id schedule_list or schedule_create returned. ` +
        `Only the given fields change; set description or location to null to clear it. ` +
        `To move an event, give both start and end; giving only one keeps the other as it is, ` +
        `so it must stay the same kind (date-time or "YYYY-MM-DD") and in order. ` +
        `Switching between a timed and an all-day event needs both. ` +
        `Recurring events, events organized by someone else, events on other calendars, ` +
        `moving an event to another calendar and deleting are not supported. ${calendarsText}`,
      inputSchema: ScheduleUpdateInputSchema,
      outputSchema: ScheduleOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => jsonResult({ schedule: await connector().update(input) }),
  );
}
