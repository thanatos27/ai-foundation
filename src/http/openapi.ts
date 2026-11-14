import type { OpenAPIHono, z } from '@hono/zod-openapi';
import { INSTRUCTIONS } from '../instructions.js';
import type { Operation, Repeat } from '../operations/index.js';
import { ErrorResponseSchema } from './schemas.js';

/** Request bodies larger than this are refused with 413 before a route runs. */
export const MAX_BODY_BYTES = 1024 * 1024;

export const SECURITY_SCHEME = 'bearerAuth';

const HTTP_NOTES = `
## HTTP API

- Every request needs \`Authorization: Bearer <API key>\`, including this document.
- Request and response bodies are JSON. Lists and searches take their filters as query parameters.
- Ids are passed exactly as returned, URL-encoded (\`encodeURIComponent\`). Ids that contain "/" (knowledge,
  projects) go in the \`id\` query parameter; in a query, send "+" as %2B.
- Dates are \`YYYY-MM-DD\`; date-times are ISO 8601 with an explicit offset.
- PATCH changes only the given fields; \`null\` clears a field where the operation says so.
- The API never retries a request by itself. If a request timed out or the connection dropped, it may or may not
  have taken effect: check with a read operation before sending it again.
- Errors are \`{"error": {"code", "message"}}\`; \`code\` is one of the values of the Error schema.`;

/** The document header, generated together with the routes (no hand-written spec). */
export const DOCUMENT_CONFIG: Parameters<OpenAPIHono['getOpenAPI31Document']>[0] = {
  openapi: '3.1.0',
  info: {
    title: 'AI Foundation',
    version: '1.0.0',
    description: `${INSTRUCTIONS.replace('Use the provided tools', 'Use the operations below')}\n${HTTP_NOTES}`,
  },
  security: [{ [SECURITY_SCHEME]: [] }],
};

const REPEAT_TEXT: Record<Repeat['kind'], string> = {
  safe: 'Safe to repeat: it changes nothing.',
  idempotent: 'Idempotent: sending the same request again leaves the same state.',
  conditional: 'Whether a repeat is safe depends on the input.',
  not_idempotent: 'Not idempotent.',
  conflict_on_repeat: 'Not idempotent.',
};

/** How a repeated request behaves, for the operation's description. */
export function repeatText(repeat: Repeat): string {
  const text = [REPEAT_TEXT[repeat.kind], repeat.note].filter(Boolean).join(' ');
  if (repeat.kind === 'safe') return `Repeating: ${text}`;
  return `Repeating: ${text} The API never retries this by itself; if the result is unknown (a timeout or a dropped connection), check its state before sending it again.`;
}

/** operationId, summary, description and tag of an operation's route. */
export function describeOperation(operation: Operation, tag: string, httpNote?: string) {
  return {
    operationId: operation.name,
    summary: operation.title,
    description: [operation.description, httpNote, repeatText(operation.repeat)].filter(Boolean).join('\n\n'),
    tags: [tag],
  };
}

/** A JSON request body. */
export function jsonBody<T extends z.ZodType>(schema: T) {
  return { required: true, content: { 'application/json': { schema } } } as const;
}

/** The success response of a route. */
export function success<S extends 200 | 201, T extends z.ZodType>(status: S, schema: T, description: string) {
  return { [status]: { description, content: { 'application/json': { schema } } } } as {
    [K in S]: { description: string; content: { 'application/json': { schema: T } } };
  };
}

const ERRORS = {
  400: 'Invalid input (code invalid_input): the parameters or body do not match the schema or its rules.',
  401: 'Missing or invalid API key (code unauthorized). Nothing was done.',
  404: 'Not found (code not_found): no item with this id in the Source of Truth.',
  409: 'Conflict (code conflict): an item with this name exists. Nothing was overwritten.',
  413: 'The request body is over 1 MiB (code payload_too_large). Nothing was done.',
  500: 'Unexpected internal error (code internal_error).',
  502:
    'The Source of Truth failed (code provider_error) or rejected AI Foundation\'s own credentials ' +
    '(code provider_auth_failed). The message says whether anything was changed when that is known.',
  503:
    'A setting (code configuration_error) or a credential (code credential_missing) AI Foundation needs is ' +
    'missing. Nothing was done.',
} as const;

/** Error responses: the common ones, plus `extra` for operations that can fail in those ways. */
export function errors(extra: readonly (404 | 409 | 413)[] = []) {
  const statuses = [400, 401, ...extra, 500, 502, 503] as const;
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: ERRORS[status], content: { 'application/json': { schema: ErrorResponseSchema } } },
    ]),
  );
}
