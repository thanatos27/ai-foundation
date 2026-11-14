import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { FoundationError, type FoundationErrorCode } from '../errors.js';

/** Machine-readable `error.code` of every HTTP error response. */
export const HTTP_ERROR_CODES = [
  'invalid_input',
  'unauthorized',
  'not_found',
  'route_not_found',
  'conflict',
  'payload_too_large',
  'provider_auth_failed',
  'provider_error',
  'credential_missing',
  'configuration_error',
  'internal_error',
] as const;
export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

/** The body of every error response. Never carries a cause, a stack trace or an exception name. */
export interface ErrorBody {
  error: { code: HttpErrorCode; message: string };
}

export function errorBody(code: HttpErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

export interface HttpError {
  status: ContentfulStatusCode;
  code: HttpErrorCode;
  message: string;
}

/** How each Foundation error is answered. A new code fails to compile until it is mapped here. */
const BY_FOUNDATION_CODE = {
  invalid_input: { status: 400, code: 'invalid_input' },
  not_found: { status: 404, code: 'not_found' },
  conflict: { status: 409, code: 'conflict' },
  credential: { status: 502, code: 'provider_auth_failed' },
  provider_api: { status: 502, code: 'provider_error' },
  credential_missing: { status: 503, code: 'credential_missing' },
  configuration: { status: 503, code: 'configuration_error' },
} as const satisfies Record<FoundationErrorCode, { status: ContentfulStatusCode; code: HttpErrorCode }>;

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';
export const INVALID_JSON_MESSAGE = 'Invalid input: the request body is not valid JSON';
export const NOT_JSON_MESSAGE = 'Invalid input: the request body must be JSON (Content-Type: application/json)';

/**
 * The response for anything a route throws. Foundation errors keep their public message (without
 * provider-written text); anything else is an internal error with a fixed message.
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof FoundationError) {
    return { ...BY_FOUNDATION_CODE[error.code], message: error.publicMessage };
  }
  // Thrown by Hono's body parsing before a route runs.
  if (error instanceof HTTPException) {
    if (error.status === 400) return { status: 400, code: 'invalid_input', message: INVALID_JSON_MESSAGE };
    if (error.status === 415) return { status: 400, code: 'invalid_input', message: NOT_JSON_MESSAGE };
  }
  return { status: 500, code: 'internal_error', message: INTERNAL_ERROR_MESSAGE };
}

/** `Invalid input: <path>: <issue>; ...` from a failed schema check (paths and Zod's messages only). */
export function issuesMessage(issues: readonly z.core.$ZodIssue[]): string {
  const details = issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`);
  return `Invalid input: ${details.join('; ')}`;
}
