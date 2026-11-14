import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ScheduleCreateInputSchema, ScheduleListFilterSchema } from '../../domain/index.js';
import type { Operations } from '../../operations/index.js';
import { describeOperation, errors, jsonBody, success } from '../openapi.js';
import { idParam, ScheduleListResponse, ScheduleResponse, ScheduleUpdateBody } from '../schemas.js';

const TAG = 'Schedule';
const ID = idParam('google_calendar:xxxxxxxx@group.calendar.google.com:abc123');

export function registerScheduleRoutes(app: OpenAPIHono, ops: Operations): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/schedules',
      ...describeOperation(
        ops.schedule_list,
        TAG,
        'start and end are required. They may mix a date and a date-time; the order is then checked in the configured time zone.',
      ),
      request: { query: ScheduleListFilterSchema },
      responses: { ...success(200, ScheduleListResponse, 'Events overlapping the period'), ...errors() },
    }),
    async (c) => c.json(await ops.schedule_list.run(c.req.valid('query')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/schedules',
      ...describeOperation(ops.schedule_create, TAG),
      request: { body: jsonBody(ScheduleCreateInputSchema) },
      responses: { ...success(201, ScheduleResponse, 'The created event'), ...errors([413]) },
    }),
    async (c) => c.json(await ops.schedule_create.run(c.req.valid('json')), 201),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/schedules/{id}',
      ...describeOperation(ops.schedule_update, TAG),
      request: { params: ID, body: jsonBody(ScheduleUpdateBody) },
      responses: { ...success(200, ScheduleResponse, 'The event after the update'), ...errors([404, 413]) },
    }),
    async (c) =>
      c.json(await ops.schedule_update.run({ id: c.req.valid('param').id, ...c.req.valid('json') }), 200),
  );
}
