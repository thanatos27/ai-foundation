import { describe, expect, it } from 'vitest';
import { httpError, networkError, projectNotFound } from '../../../src/connectors/github/errors.js';
import { CredentialError, NotFoundError, ProviderApiError } from '../../../src/errors.js';

const GET = { owner: 'thanatos27', repo: 'private-repo' };
const failure = (status: number, headers: Record<string, string> = {}, body: unknown = { message: 'GitHub says no' }) => ({
  status,
  headers: new Headers(headers),
  body,
});

describe('httpError', () => {
  it.each(['list', GET] as const)('maps 401 to a credential error (%o)', (request) => {
    const error = httpError(failure(401, {}, { message: 'Bad credentials' }), request);
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe('Credential error: GitHub rejected the token (HTTP 401)');
  });

  it.each([403, 429])('maps a primary rate limit (HTTP %i) with the reset time', (status) => {
    const reset = Date.UTC(2026, 9, 15, 13, 0, 0) / 1000;
    const error = httpError(
      failure(status, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, { message: 'API rate limit exceeded for user ID 1.' }),
      GET,
    );
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('GitHub API error: rate limit exceeded; resets at 2026-10-15T13:00:00Z');
  });

  it('maps a primary rate limit without a usable reset header', () => {
    const error = httpError(failure(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'soon' }), 'list');
    expect(error.message).toBe('GitHub API error: rate limit exceeded');
  });

  it.each([
    ['retry-after', { 'retry-after': '60' }, undefined, 'secondary rate limit exceeded; retry after 60 seconds'],
    ['the message', {}, { message: 'You have exceeded a secondary rate limit.' }, 'secondary rate limit exceeded'],
  ])('maps a secondary rate limit recognized by %s', (_label, headers, body, message) => {
    const error = httpError(failure(403, headers, body), GET);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe(`GitHub API error: ${message}`);
  });

  it('maps a 429 without rate limit headers', () => {
    expect(httpError(failure(429, {}, {}), 'list').message).toBe('GitHub API error: rate limit exceeded (HTTP 429)');
  });

  it.each([403, 404, 451])('maps HTTP %i of one repository to the same not found error', (status) => {
    const error = httpError(failure(status), GET);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(
      'Not found: project github:thanatos27/private-repo (it does not exist or the GitHub token cannot access it)',
    );
    expect(error.cause).toEqual({ status, githubMessage: 'GitHub says no', documentationUrl: undefined });
  });

  it('maps a 403 of the repository list to a credential error', () => {
    const error = httpError(failure(403, {}, { message: 'Resource not accessible by personal access token' }), 'list');
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe('Credential error: the GitHub token is not allowed to list repositories (HTTP 403)');
  });

  it.each([
    [404, 'list'],
    [410, GET],
    [422, 'list'],
    [500, GET],
    [502, 'list'],
    [503, GET],
  ] as const)('maps HTTP %i to a provider error (%o)', (status, request) => {
    const error = httpError(failure(status), request);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe(`GitHub API error: HTTP ${status}`);
  });

  it("never shows GitHub's own message", () => {
    for (const status of [400, 401, 403, 404, 500]) {
      for (const request of ['list', GET] as const) {
        expect(httpError(failure(status, {}, { message: 'raw provider text' }), request).message).not.toContain('raw provider text');
      }
    }
  });
});

describe('networkError', () => {
  it('reports a timeout', () => {
    const error = networkError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 30_000);
    expect(error.message).toBe('GitHub API error: no response within 30 seconds');
  });

  it('shows the error code only', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com secret-ish detail'), { code: 'ENOTFOUND' });
    const error = networkError(new TypeError('fetch failed', { cause }), 30_000);
    expect(error.message).toBe('GitHub API error: could not reach api.github.com (ENOTFOUND)');
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('shows no code it cannot recognize', () => {
    expect(networkError(new TypeError('Bearer xyz is invalid'), 30_000).message).toBe(
      'GitHub API error: could not reach api.github.com',
    );
  });
});

describe('projectNotFound', () => {
  it('does not say whether the repository exists', () => {
    expect(projectNotFound('github:a/b').message).toBe(
      'Not found: project github:a/b (it does not exist or the GitHub token cannot access it)',
    );
  });
});
