/**
 * Errors a tool call can fail with. The MCP SDK turns a thrown error into an `isError` tool
 * result carrying `error.message`, so each message starts with its category and must never
 * contain credentials. Provider errors are kept only as `cause`.
 */

export type FoundationErrorCode = 'invalid_input' | 'credential' | 'not_found' | 'provider_api' | 'configuration';

export abstract class FoundationError extends Error {
  abstract readonly code: FoundationErrorCode;
}

/** Input that passed the schema but is still unusable (e.g. a malformed provider ID). */
export class InputValidationError extends FoundationError {
  override name = 'InputValidationError';
  readonly code = 'invalid_input';
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid input: ${message}`, options);
  }
}

/** Credentials are missing, rejected or expired. */
export class CredentialError extends FoundationError {
  override name = 'CredentialError';
  readonly code = 'credential';
  constructor(message: string, options?: ErrorOptions) {
    super(`Credential error: ${message}`, options);
  }
}

/** The addressed item does not exist in the Source of Truth. */
export class NotFoundError extends FoundationError {
  override name = 'NotFoundError';
  readonly code = 'not_found';
  constructor(message: string, options?: ErrorOptions) {
    super(`Not found: ${message}`, options);
  }
}

/** The provider API failed for a reason other than the ones above. */
export class ProviderApiError extends FoundationError {
  override name = 'ProviderApiError';
  readonly code = 'provider_api';
  /** @param provider Human-readable provider name, e.g. `Todoist`. */
  constructor(provider: string, message: string, options?: ErrorOptions) {
    super(`${provider} API error: ${message}`, options);
  }
}

/** Configuration needed by this call is missing or wrong. Startup config errors are `ConfigError`. */
export class ConfigurationError extends FoundationError {
  override name = 'ConfigurationError';
  readonly code = 'configuration';
  constructor(message: string, options?: ErrorOptions) {
    super(`Configuration error: ${message}`, options);
  }
}
