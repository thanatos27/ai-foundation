import { describe, expect, it } from 'vitest';
import { type CalendarResources, calendarApiFrom } from '../../../src/connectors/google-calendar/client.js';

/** Fake googleapis resources: records request parameters and serves pages keyed by pageToken. */
function fakeResources(pages: { calendars?: unknown[][]; events?: unknown[][] } = {}) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const page = (all: unknown[][] | undefined, params: { pageToken?: string | undefined }) => {
    const index = Number(params.pageToken ?? 0);
    const items = all?.[index] ?? [];
    return { items, nextPageToken: all && index + 1 < all.length ? String(index + 1) : undefined };
  };
  const resources = {
    events: {
      insert: async (params: Record<string, unknown>) => {
        requests.push({ method: 'events.insert', params });
        return { data: { id: 'evt1', ...(params.requestBody as object) } };
      },
      get: async (params: Record<string, unknown>) => {
        requests.push({ method: 'events.get', params });
        return { data: { id: params.eventId } };
      },
      patch: async (params: Record<string, unknown>) => {
        requests.push({ method: 'events.patch', params });
        return { data: { id: params.eventId, ...(params.requestBody as object) } };
      },
      list: async (params: Record<string, unknown>) => {
        requests.push({ method: 'events.list', params });
        return { data: page(pages.events, params) };
      },
    },
    calendarList: {
      list: async (params: Record<string, unknown>) => {
        requests.push({ method: 'calendarList.list', params });
        return { data: page(pages.calendars, params) };
      },
    },
  } as unknown as CalendarResources;
  return { resources, requests };
}

describe('calendarApiFrom', () => {
  it('lists hidden calendars too, excluding free/busy-only ones, across pages', async () => {
    const { resources, requests } = fakeResources({ calendars: [[{ id: 'a' }], [{ id: 'hidden', hidden: true }]] });
    const calendars = await calendarApiFrom(resources).listCalendars();

    expect(calendars.map((c) => c.id)).toEqual(['a', 'hidden']);
    expect(requests).toEqual([
      { method: 'calendarList.list', params: { minAccessRole: 'reader', showHidden: true, maxResults: 250, pageToken: undefined } },
      { method: 'calendarList.list', params: { minAccessRole: 'reader', showHidden: true, maxResults: 250, pageToken: '1' } },
    ]);
  });

  it('lists expanded, non-deleted events for the range across pages', async () => {
    const { resources, requests } = fakeResources({ events: [[{ id: 'e1' }], [{ id: 'e2' }]] });
    const range = { timeMin: '2026-10-11T15:00:00.000Z', timeMax: '2026-10-18T15:00:00.000Z' };
    const events = await calendarApiFrom(resources).listEvents('cal@example.com', range);

    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(requests[0]).toEqual({
      method: 'events.list',
      params: {
        calendarId: 'cal@example.com',
        ...range,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: false,
        maxResults: 2500,
        pageToken: undefined,
      },
    });
    expect(requests[1]?.params.pageToken).toBe('1');
  });

  it('inserts into the given calendar', async () => {
    const { resources, requests } = fakeResources();
    const event = { summary: 'a', start: { date: '2026-10-19' }, end: { date: '2026-10-20' } };
    await calendarApiFrom(resources).insertEvent('af@group.calendar.google.com', event);
    expect(requests).toEqual([
      { method: 'events.insert', params: { calendarId: 'af@group.calendar.google.com', requestBody: event } },
    ]);
  });

  it('gets one event of the given calendar', async () => {
    const { resources, requests } = fakeResources();
    await calendarApiFrom(resources).getEvent('af@group.calendar.google.com', 'evt1');
    expect(requests).toEqual([
      { method: 'events.get', params: { calendarId: 'af@group.calendar.google.com', eventId: 'evt1' } },
    ]);
  });

  it('patches only the given fields, keeping null to clear one', async () => {
    const { resources, requests } = fakeResources();
    const patch = { summary: 'b', description: null };
    await calendarApiFrom(resources).patchEvent('af@group.calendar.google.com', 'evt1', patch);
    expect(requests).toEqual([
      {
        method: 'events.patch',
        params: { calendarId: 'af@group.calendar.google.com', eventId: 'evt1', requestBody: patch },
      },
    ]);
  });
});
