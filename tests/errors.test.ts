import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  CredentialError,
  errorText,
  InputValidationError,
  MissingCredentialError,
  PROVIDER_TEXT_OMITTED,
  ProviderApiError,
  providerText,
} from '../src/errors.js';

describe('FoundationError messages', () => {
  it('uses the same text for MCP and HTTP when built from a string', () => {
    const error = new InputValidationError('bad id');
    expect(error.message).toBe('Invalid input: bad id');
    expect(error.publicMessage).toBe(error.message);
  });

  it('joins every part for MCP and leaves provider text out for HTTP', () => {
    const error = new ProviderApiError('Todoist', ['HTTP 503: ', providerText('from the SDK'), '; check the task']);
    expect(error.message).toBe('Todoist API error: HTTP 503: from the SDK; check the task');
    expect(error.publicMessage).toBe(`Todoist API error: HTTP 503: ${PROVIDER_TEXT_OMITTED}; check the task`);
  });

  it('nests another error with its own split', () => {
    const cause = new ProviderApiError('Notion', ['HTTP 502 bad_gateway: ', providerText('secret')]);
    const error = new ProviderApiError('Notion', ['updated, but appending failed: ', errorText(cause)]);
    expect(error.message).toBe('Notion API error: updated, but appending failed: Notion API error: HTTP 502 bad_gateway: secret');
    expect(error.publicMessage).toBe(
      `Notion API error: updated, but appending failed: Notion API error: HTTP 502 bad_gateway: ${PROVIDER_TEXT_OMITTED}`,
    );
  });

  it('treats an error that is not a FoundationError as provider text', () => {
    expect(errorText(new Error('secret'))).toEqual({ full: 'secret', public: PROVIDER_TEXT_OMITTED });
    expect(errorText('secret')).toEqual({ full: 'secret', public: PROVIDER_TEXT_OMITTED });
  });
});

describe('error classes', () => {
  it('words a conflict as the input error MCP clients have always seen', () => {
    const error = new ConflictError('knowledge "obsidian:a.md" already exists');
    expect(error.code).toBe('conflict');
    expect(error.message).toBe('Invalid input: knowledge "obsidian:a.md" already exists');
    expect(error).not.toBeInstanceOf(InputValidationError);
  });

  it('tells a missing credential from one the provider rejected', () => {
    const missing = new MissingCredentialError('set TODOIST_API_TOKEN');
    const rejected = new CredentialError('Todoist rejected the API token (HTTP 401)');
    expect(missing).toBeInstanceOf(CredentialError);
    expect(missing.code).toBe('credential_missing');
    expect(missing.message).toBe('Credential error: set TODOIST_API_TOKEN');
    expect(rejected.code).toBe('credential');
  });
});
