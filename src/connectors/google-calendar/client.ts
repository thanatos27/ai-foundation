import { calendar, type calendar_v3 } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import type { CredentialProvider, GoogleOAuthCredentials } from '../../credentials/types.js';
import { CredentialError, FoundationError, ProviderApiError } from '../../errors.js';

export type GoogleEvent = calendar_v3.Schema$Event;
export type GoogleCalendarListEntry = calendar_v3.Schema$CalendarListEntry;

/**
 * OAuth scopes requested by `npm run auth:google`. `calendar.events` can write to every calendar;
 * the connector itself restricts writes to the configured calendar.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

/** The Calendar API calls the connector uses, with pagination done. Tests inject a fake. */
export interface CalendarApi {
  insertEvent(calendarId: string, event: GoogleEvent): Promise<GoogleEvent>;
  /** Calendars the user can read event details of (free/busy-only calendars are excluded). */
  listCalendars(): Promise<GoogleCalendarListEntry[]>;
  /** Single (expanded) events overlapping [timeMin, timeMax), excluding deleted ones. */
  listEvents(calendarId: string, range: { timeMin: string; timeMax: string }): Promise<GoogleEvent[]>;
}

export type CalendarApiFactory = (credentials: GoogleOAuthCredentials) => CalendarApi;

/** The googleapis Calendar methods the connector uses. Tests fake these to check request parameters. */
export interface CalendarResources {
  events: {
    insert(params: calendar_v3.Params$Resource$Events$Insert): Promise<{ data: GoogleEvent }>;
    list(params: calendar_v3.Params$Resource$Events$List): Promise<{ data: calendar_v3.Schema$Events }>;
  };
  calendarList: {
    list(params: calendar_v3.Params$Resource$Calendarlist$List): Promise<{ data: calendar_v3.Schema$CalendarList }>;
  };
}

export const createCalendarApi: CalendarApiFactory = ({ clientId, clientSecret, refreshToken }) => {
  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials({ refresh_token: refreshToken });
  return calendarApiFrom(calendar({ version: 'v3', auth }));
};

/** Builds the connector-facing API, with pagination, on top of the googleapis client. */
export function calendarApiFrom(api: CalendarResources): CalendarApi {
  return {
    async insertEvent(calendarId, requestBody) {
      return (await api.events.insert({ calendarId, requestBody })).data;
    },

    async listCalendars() {
      const entries: GoogleCalendarListEntry[] = [];
      let pageToken: string | undefined;
      do {
        // showHidden: calendars hidden in the UI are still readable and must not be skipped.
        const { data } = await api.calendarList.list({
          minAccessRole: 'reader',
          showHidden: true,
          maxResults: 250,
          pageToken,
        });
        entries.push(...(data.items ?? []));
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return entries;
    },

    async listEvents(calendarId, { timeMin, timeMax }) {
      const events: GoogleEvent[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await api.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          showDeleted: false,
          maxResults: 2500,
          pageToken,
        });
        events.push(...(data.items ?? []));
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return events;
    },
  };
}

/** Creates the API client on first use, so the server starts without credentials. */
export function lazyCalendarApi(
  credentials: CredentialProvider,
  factory: CalendarApiFactory = createCalendarApi,
): () => Promise<CalendarApi> {
  let api: Promise<CalendarApi> | undefined;
  return () => {
    api ??= credentials.getGoogleOAuthCredentials().then(factory);
    api.catch(() => (api = undefined));
    return api;
  };
}

interface GoogleErrorShape {
  message?: string;
  status?: number;
  response?: { status?: number; data?: unknown };
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

function errorReasons(data: unknown): string[] {
  const errors = (data as { error?: { errors?: { reason?: string }[] } } | undefined)?.error?.errors ?? [];
  return errors.map((e) => e.reason ?? '');
}

/**
 * Converts anything thrown by the Google client into a Foundation error.
 * `notFound` supplies the error for a 404 (otherwise a provider error); `context` prefixes the
 * provider error detail, e.g. which calendar failed.
 */
export function toFoundationError(
  error: unknown,
  { notFound, context }: { notFound?: () => FoundationError; context?: string } = {},
): FoundationError {
  if (error instanceof FoundationError) return error;
  const e = (error ?? {}) as GoogleErrorShape;
  const status = e.status ?? e.response?.status;
  const data = e.response?.data;
  const message = e.message ?? String(error);
  const options = { cause: error };

  if ((data as { error?: unknown } | undefined)?.error === 'invalid_grant' || /invalid_grant/.test(message)) {
    return new CredentialError(
      'Google rejected the refresh token (invalid_grant); run `npm run auth:google` and update GOOGLE_OAUTH_REFRESH_TOKEN',
      options,
    );
  }
  if (status === 401) return new CredentialError(`Google rejected the credentials (HTTP 401): ${message}`, options);
  if (status === 403 && !errorReasons(data).some((reason) => RATE_LIMIT_REASONS.has(reason))) {
    return new CredentialError(`Google denied access (HTTP 403): ${message}`, options);
  }
  if (status === 404 && notFound) return notFound();
  const detail = status ? `HTTP ${status}: ${message}` : message;
  return new ProviderApiError('Google Calendar', context ? `${context}: ${detail}` : detail, options);
}
