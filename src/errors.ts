/**
 * Errors a tool call can fail with. The MCP SDK turns a thrown error into an `isError` tool
 * result carrying `error.message`, so each message starts with its category and must never
 * contain credentials. Provider errors are kept only as `cause`.
 *
 * A message is built from parts: plain strings are written by AI Foundation, `providerText` /
 * `errorText` parts come from an SDK or a provider. `message` (MCP) joins them all;
 * `publicMessage` (HTTP API) leaves the provider-written parts out, because their content is not
 * under AI Foundation's control.
 */

export type FoundationErrorCode =
  | 'invalid_input'
  | 'credential'
  | 'credential_missing'
  | 'not_found'
  | 'conflict'
  | 'provider_api'
  | 'configuration';

/** One piece of an error message: AI Foundation's own text, or text with a public replacement. */
export type MessagePart = string | { readonly full: string; readonly public: string };
export type Message = string | readonly MessagePart[];

/** Shown over HTTP in place of text an SDK or a provider wrote. */
export const PROVIDER_TEXT_OMITTED = '(provider details omitted)';

/** Text an SDK or a provider wrote. Shown to MCP clients as before; never sent over the HTTP API. */
export function providerText(text: string): MessagePart {
  return { full: text, public: PROVIDER_TEXT_OMITTED };
}

/**
 * The whole message of another error, keeping its own split (e.g. the cause of a failed rollback).
 * Anything that is not a FoundationError counts as provider text.
 */
export function errorText(error: unknown): MessagePart {
  if (error instanceof FoundationError) return { full: error.message, public: error.publicMessage };
  return providerText(error instanceof Error ? error.message : String(error));
}

function join(message: Message): { full: string; public: string } {
  if (typeof message === 'string') return { full: message, public: message };
  return {
    full: message.map((part) => (typeof part === 'string' ? part : part.full)).join(''),
    public: message.map((part) => (typeof part === 'string' ? part : part.public)).join(''),
  };
}

export abstract class FoundationError extends Error {
  abstract readonly code: FoundationErrorCode;
  /** `message` without the provider-written parts: what the HTTP API returns. */
  readonly publicMessage: string;

  protected constructor(prefix: string, message: Message, options?: ErrorOptions) {
    const text = join(message);
    super(`${prefix}${text.full}`, options);
    this.publicMessage = `${prefix}${text.public}`;
  }
}

/** Input that passed the schema but is still unusable (e.g. a malformed provider ID). */
export class InputValidationError extends FoundationError {
  override name = 'InputValidationError';
  readonly code = 'invalid_input';
  constructor(message: Message, options?: ErrorOptions) {
    super('Invalid input: ', message, options);
  }
}

/** Credentials are rejected or expired by the provider. */
export class CredentialError extends FoundationError {
  override name = 'CredentialError';
  readonly code: 'credential' | 'credential_missing' = 'credential';
  constructor(message: Message, options?: ErrorOptions) {
    super('Credential error: ', message, options);
  }
}

/** A credential AI Foundation needs is not set, or is set to a value that cannot be used. */
export class MissingCredentialError extends CredentialError {
  override name = 'MissingCredentialError';
  override readonly code = 'credential_missing';
}

/** The addressed item does not exist in the Source of Truth. */
export class NotFoundError extends FoundationError {
  override name = 'NotFoundError';
  readonly code = 'not_found';
  constructor(message: Message, options?: ErrorOptions) {
    super('Not found: ', message, options);
  }
}

/**
 * The request conflicts with what already exists (e.g. a file with that name); nothing was
 * overwritten. Worded as an input error, as MCP clients have always seen it.
 */
export class ConflictError extends FoundationError {
  override name = 'ConflictError';
  readonly code = 'conflict';
  constructor(message: Message, options?: ErrorOptions) {
    super('Invalid input: ', message, options);
  }
}

/** The provider API failed for a reason other than the ones above. */
export class ProviderApiError extends FoundationError {
  override name = 'ProviderApiError';
  readonly code = 'provider_api';
  /** @param provider Human-readable provider name, e.g. `Todoist`. */
  constructor(provider: string, message: Message, options?: ErrorOptions) {
    super(`${provider} API error: `, message, options);
  }
}

/** Configuration needed by this call is missing or wrong. Startup config errors are `ConfigError`. */
export class ConfigurationError extends FoundationError {
  override name = 'ConfigurationError';
  readonly code = 'configuration';
  constructor(message: Message, options?: ErrorOptions) {
    super('Configuration error: ', message, options);
  }
}
