/**
 * What Google API errors (googleapis / gaxios) have in common, for the connectors that classify them
 * (Google Calendar, Google Drive). Only facts are read here; each connector decides what they mean.
 */

interface GoogleErrorShape {
  message?: string;
  status?: number;
  response?: { status?: number; data?: unknown };
}

export interface GoogleErrorInfo {
  /** HTTP status, when the request got a response. */
  status: number | undefined;
  /** `error.errors[].reason` of the response body, e.g. `rateLimitExceeded`. */
  reasons: string[];
  /** The SDK's message: provider text, never shown over HTTP. */
  message: string;
  /** The refresh token was rejected: the user must authorize again. */
  invalidGrant: boolean;
}

/** Reasons Google gives for a 403 / 429 that means "slow down", not "not allowed". */
export const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
]);

export function googleErrorInfo(error: unknown): GoogleErrorInfo {
  const e = (error ?? {}) as GoogleErrorShape;
  const data = e.response?.data;
  const message = e.message ?? String(error);
  const errors = (data as { error?: { errors?: { reason?: string }[] } } | undefined)?.error?.errors;
  return {
    status: e.status ?? e.response?.status,
    reasons: Array.isArray(errors) ? errors.map((item) => item.reason ?? '') : [],
    message,
    invalidGrant: (data as { error?: unknown } | undefined)?.error === 'invalid_grant' || /invalid_grant/.test(message),
  };
}
