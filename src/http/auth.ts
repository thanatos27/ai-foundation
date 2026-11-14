import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { errorBody } from './errors.js';

/** The environment variable holding the HTTP API key. */
export const API_KEY_VARIABLE = 'AI_FOUNDATION_API_KEY';
export const MIN_API_KEY_LENGTH = 32;

/** The API key is missing or unusable; the HTTP server does not start. The message names no value. */
export class ApiKeyError extends Error {
  override name = 'ApiKeyError';
}

/**
 * The API key from the environment: at least 32 printable ASCII characters (no spaces), so that it
 * is hard to guess and can be sent in an Authorization header. Surrounding whitespace is ignored.
 */
export function parseApiKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  const required = `the HTTP server requires it (the MCP server does not); set ${API_KEY_VARIABLE} to a random key`;
  if (key === '') throw new ApiKeyError(`${API_KEY_VARIABLE} is not set: ${required}`);
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new ApiKeyError(`${API_KEY_VARIABLE} must contain only printable ASCII characters without spaces`);
  }
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new ApiKeyError(`${API_KEY_VARIABLE} must be at least ${MIN_API_KEY_LENGTH} characters long`);
  }
  return key;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Accepts only `Authorization: Bearer <apiKey>` (the scheme in any case). Runs before every route,
 * including /openapi.json and unknown paths, so nothing reaches a connector without the key.
 * Both sides are hashed before the constant-time comparison, so the key length is not revealed.
 */
export function bearerAuth(apiKey: string): MiddlewareHandler {
  const expected = digest(apiKey);
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const token = header === undefined ? undefined : /^Bearer +([^\s]+)$/i.exec(header.trim())?.[1];
    if (token === undefined || !timingSafeEqual(digest(token), expected)) {
      const message =
        header === undefined
          ? 'Authorization: Bearer <API key> is required'
          : 'The API key is not valid (send Authorization: Bearer <API key>)';
      return c.json(errorBody('unauthorized', message), 401, { 'WWW-Authenticate': 'Bearer' });
    }
    await next();
  };
}
