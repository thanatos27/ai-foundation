import { CredentialError, type FoundationError, NotFoundError, ProviderApiError } from '../../errors.js';
import { formatGitHubProjectId, type GitHubRepositoryRef } from './id.js';

/** Which request failed: the repository list, or one repository addressed by an exact project id. */
export type GitHubRequest = 'list' | GitHubRepositoryRef;

/** A non-200 response, reduced to what error mapping needs. */
export interface GitHubHttpFailure {
  status: number;
  headers: Headers;
  /** The parsed JSON body, if any. */
  body: unknown;
}

/**
 * The same error whether the repository does not exist, the token cannot access it, or it is outside
 * the token's repository list: callers cannot tell them apart.
 */
export function projectNotFound(id: string, cause?: unknown): NotFoundError {
  return new NotFoundError(`project ${id} (it does not exist or the GitHub token cannot access it)`, { cause });
}

/**
 * Converts a failed response into a Foundation error. Messages carry the status and fixed text only:
 * GitHub's own message is used to recognize rate limits and kept in `cause`, never shown.
 */
export function httpError({ status, headers, body }: GitHubHttpFailure, request: GitHubRequest): FoundationError {
  const githubMessage = stringField(body, 'message');
  const cause = { status, githubMessage, documentationUrl: stringField(body, 'documentation_url') };
  const options = { cause };

  if (status === 401) return new CredentialError(`GitHub rejected the token (HTTP ${status})`, options);
  const rateLimit = rateLimitMessage(status, headers, githubMessage);
  if (rateLimit) return new ProviderApiError('GitHub', rateLimit, options);
  if (request === 'list') {
    if (status === 403) {
      return new CredentialError(`the GitHub token is not allowed to list repositories (HTTP ${status})`, options);
    }
  } else if (status === 403 || status === 404 || status === 451) {
    return projectNotFound(formatGitHubProjectId(request.owner, request.repo), cause);
  }
  return new ProviderApiError('GitHub', `HTTP ${status}`, options);
}

/** A request that got no response. The original error is kept as `cause`; only its code is shown. */
export function networkError(error: unknown, timeoutMs: number): ProviderApiError {
  if ((error as Error | undefined)?.name === 'TimeoutError') {
    return new ProviderApiError('GitHub', `no response within ${Math.ceil(timeoutMs / 1000)} seconds`, { cause: error });
  }
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code ?? (error as { code?: unknown })?.code;
  const shownCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? ` (${code})` : '';
  return new ProviderApiError('GitHub', `could not reach api.github.com${shownCode}`, { cause: error });
}

/**
 * Primary limit: `x-ratelimit-remaining: 0`, with the reset time. Secondary limit: `retry-after`, or a
 * 403 / 429 whose message mentions the rate limit. No retry or wait is attempted.
 */
function rateLimitMessage(status: number, headers: Headers, githubMessage: string | undefined): string | undefined {
  if (status !== 403 && status !== 429) return undefined;
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    const resetAt = Number.isInteger(reset) && reset > 0 ? new Date(reset * 1000).toISOString().replace('.000Z', 'Z') : undefined;
    return `rate limit exceeded${resetAt ? `; resets at ${resetAt}` : ''}`;
  }
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null || /rate limit/i.test(githubMessage ?? '')) {
    const seconds = retryAfter === null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
    return `secondary rate limit exceeded${Number.isInteger(seconds) && seconds >= 0 ? `; retry after ${seconds} seconds` : ''}`;
  }
  return status === 429 ? `rate limit exceeded (HTTP ${status})` : undefined;
}

function stringField(body: unknown, key: string): string | undefined {
  const value = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}
