import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { TaskConnector } from '../connectors/types.js';
import {
  TaskCreateInputSchema,
  TaskIdInputSchema,
  TaskListFilterSchema,
  TaskSchema,
  TaskUpdateInputSchema,
} from '../domain/index.js';
import { ConfigurationError } from '../errors.js';
import type { ToolContext } from './index.js';
import { jsonResult } from './result.js';

const TaskOutputSchema = z.object({ task: TaskSchema });
const TaskListOutputSchema = z.object({ tasks: z.array(TaskSchema) });

/** Registers task_create / task_list / task_update / task_complete (Source of Truth: Todoist). */
export function registerTaskTools(server: McpServer, { config, connectors }: ToolContext): void {
  const timeZone = config.defaults.timezone;
  const dates =
    `Dates are "YYYY-MM-DD" (a deadline day) or ISO 8601 date-times with an explicit offset. ` +
    `Resolve relative expressions such as "tomorrow" or "Friday" yourself; the user's time zone is ${timeZone}.`;
  const recurrence =
    `recurrence is a Todoist recurring rule written in English, e.g. "every day", "every monday", ` +
    `"every weekday at 9am", "every month on the 25th". Use "every!" (e.g. "every! 3 days") to count the next due ` +
    `from the completion date instead of the schedule. Translate the user's words (e.g. 毎週月曜 → "every monday"); ` +
    `Todoist computes the dues, so do not compute them yourself. Todoist may return the rule reworded.`;

  const connector = (): TaskConnector => {
    if (!connectors.task) throw new ConfigurationError('the task source (Todoist) is not configured');
    return connectors.task;
  };

  server.registerTool(
    'task_create',
    {
      title: 'Create task',
      description:
        `Create a task (an executable action with an optional deadline) in the Todoist Inbox. ` +
        `status defaults to "inbox"; "done" is not allowed. ${dates} ${recurrence} ` +
        `Do not pass due together with recurrence. If Todoist does not read the rule as recurring, no task is created ` +
        `and an error is returned. For an event or a time block at a specific time, use schedule_create instead.`,
      inputSchema: TaskCreateInputSchema,
      outputSchema: TaskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => jsonResult({ task: await connector().create(input) }),
  );

  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description:
        `List open tasks in the Todoist Inbox. Every filter is optional and narrows the result: ` +
        `status matches any of the given values, tags must all be present, and due_before / due_after ` +
        `are inclusive and exclude tasks without a due. Completed tasks are not returned. ${dates} ` +
        `Each task has recurrence (its recurring rule, or null) and due (the next occurrence for a recurring task). ` +
        `Use the returned id with task_update or task_complete.`,
      inputSchema: TaskListFilterSchema,
      outputSchema: TaskListOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (filter) => jsonResult({ tasks: await connector().list(filter) }),
  );

  server.registerTool(
    'task_update',
    {
      title: 'Update task',
      description:
        `Update a task by id ("todoist:<id>", from task_list). Only the given fields change; ` +
        `due: null removes the deadline, area: null removes the area, and tags replaces the task's tags. ` +
        `To complete a task use task_complete. ${dates} ${recurrence} ` +
        `recurrence changes the rule (Todoist recomputes the next due); recurrence: null removes the rule together ` +
        `with the due. recurrence must be the only field in its task_update; change title / status / area / tags ` +
        `in a separate call. If Todoist does not read the rule as recurring, the task is left as before (a recurring ` +
        `task's next due may be recalculated) and an error is returned. Changing the rule keeps the current time of ` +
        `day unless the rule names a time (e.g. "every day at 7am"). The due of a recurring task cannot be changed ` +
        `or cleared with due: that request is rejected without changing anything, because it would remove the ` +
        `recurrence. Postponing a single occurrence is not supported. title / status / area / tags changes keep ` +
        `the recurrence.`,
      inputSchema: TaskUpdateInputSchema,
      outputSchema: TaskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => jsonResult({ task: await connector().update(input) }),
  );

  server.registerTool(
    'task_complete',
    {
      title: 'Complete task',
      description:
        `Complete a task by id ("todoist:<id>", from task_list) and return its resulting state. ` +
        `A recurring task moves to its next occurrence and is returned still open with the new due and the same recurrence.`,
      inputSchema: TaskIdInputSchema,
      outputSchema: TaskOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ id }) => jsonResult({ task: await connector().complete(id) }),
  );
}
