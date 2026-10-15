import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ScheduleConnector } from '../connectors/types.js';
import { ScheduleCreateInputSchema, ScheduleListFilterSchema, ScheduleSchema } from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const ScheduleOutputSchema = z.object({ schedule: ScheduleSchema });
const ScheduleListOutputSchema = z.object({ schedules: z.array(ScheduleSchema) });

/** Registers schedule_create / schedule_list (Source of Truth: Google Calendar). */
export function registerScheduleTools(server: McpServer, { config, connectors }: ToolContext): void {
  const timeZone = config.defaults.timezone;

  const connector = (): ScheduleConnector => {
    if (!connectors.schedule) throw new ConfigurationError('the schedule source (Google Calendar) is not configured');
    return connectors.schedule;
  };

  server.registerTool(
    'schedule_create',
    {
      title: 'Create schedule',
      description:
        `Create an event or time block on the AI Foundation calendar in Google Calendar ` +
        `(the only calendar it writes to). ` +
        `Timed event: start / end are ISO 8601 date-times with an explicit offset; end defaults to one hour after start. ` +
        `All-day event: start / end are "YYYY-MM-DD" and end is the last day, inclusive; end defaults to a single day. ` +
        `Do not mix the two forms. Resolve relative expressions such as "Saturday 14:00" yourself; ` +
        `the user's time zone is ${timeZone}. For a deadline without a time block, use task_create instead.`,
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
        `List events overlapping a period across every Google Calendar the user can read. ` +
        `start / end are "YYYY-MM-DD" (whole days, end inclusive, in ${timeZone}) or ISO 8601 date-times with an offset. ` +
        `All-day events are returned with "YYYY-MM-DD" start / end, end inclusive.`,
      inputSchema: ScheduleListFilterSchema,
      outputSchema: ScheduleListOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (filter) => jsonResult({ schedules: await connector().list(filter) }),
  );
}
