import type { CredentialProvider } from '../../credentials/types.js';
import { CredentialError, ProviderApiError } from '../../errors.js';
import { type GitHubRequest, httpError, networkError } from './errors.js';

/** The only origin a request carrying the token is sent to. GitHub Enterprise Server is not supported. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * REST API version sent with every request. Pinned rather than left to GitHub's default so that a
 * new default version cannot change the response fields the connector reads.
 */
export const GITHUB_API_VERSION = '2022-11-28';

const USER_AGENT = 'ai-foundation';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * Every repository the token has explicit access to (as owner, collaborator or organization member;
 * for a fine-grained token, the repositories it was given), of any visibility, archived and forks included.
 */
const LIST_URL =
  `${GITHUB_API_ORIGIN}/user/repos?per_page=100&visibility=all` +
  `&affiliation=owner,collaborator,organization_member&sort=full_name&direction=asc`;

/** The read-only part of the GitHub REST API the connector uses. Tests inject a fake. */
export interface GitHubClient {
  /** Every page of GET /user/repos, as unparsed JSON items. Throws, without a partial result, if any page fails. */
  listRepositories(): Promise<unknown[]>;
  /** GET /repos/{owner}/{repo}, following GitHub's redirects for renamed or transferred repositories. */
  getRepository(owner: string, repo: string): Promise<unknown>;
}

export interface GitHubClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Per request, including reading the body. Not a retry: a timeout fails the call. */
  timeoutMs?: number;
}

export type GitHubClientFactory = (token: string) => GitHubClient;

/**
 * A `fetch` client that sends GET requests only, with the token only to `https://api.github.com`:
 * redirects are followed by hand and, like pagination links, refused when they leave that origin.
 */
export function createGitHubClient(token: string, options: GitHubClientOptions = {}): GitHubClient {
  // fetch reports an invalid header value with the value itself in the message: never let it see one.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new CredentialError('GITHUB_TOKEN contains characters that cannot be sent in an HTTP header');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };

  async function send(url: string): Promise<Response> {
    let current = url;
    for (let redirects = 0; ; redirects += 1) {
      assertGitHubOrigin(current);
      let response: Response;
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw networkError(error, timeoutMs);
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) throw new ProviderApiError('GitHub', `HTTP ${response.status} without a redirect location`);
      if (redirects >= MAX_REDIRECTS) throw new ProviderApiError('GitHub', 'too many redirects');
      current = resolveUrl(location, current);
    }
  }

  /** The JSON body of a 200 response; any other status becomes a Foundation error. */
  async function getJson(url: string, request: GitHubRequest): Promise<{ body: unknown; response: Response }> {
    const response = await send(url);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw networkError(error, timeoutMs);
    }
    const body = parseJson(text);
    if (response.status !== 200) throw httpError({ status: response.status, headers: response.headers, body }, request);
    if (body === undefined) throw new ProviderApiError('GitHub', 'the response is not valid JSON');
    return { body, response };
  }

  return {
    async listRepositories() {
      const items: unknown[] = [];
      const visited = new Set<string>();
      let url: string | undefined = LIST_URL;
      while (url) {
        if (visited.has(url)) throw new ProviderApiError('GitHub', 'the repository list links back to a page already read');
        visited.add(url);
        const { body, response } = await getJson(url, 'list');
        if (!Array.isArray(body)) throw new ProviderApiError('GitHub', 'the repository list is not an array');
        items.push(...(body as unknown[]));
        url = nextPageUrl(response.headers.get('link'), url);
      }
      return items;
    },

    async getRepository(owner, repo) {
      const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      return (await getJson(url, { owner, repo })).body;
    },
  };
}

/** Creates the client on first use, so the server starts without GITHUB_TOKEN; looks the token up again after a failure. */
export function lazyGitHubClient(
  credentials: CredentialProvider,
  factory: GitHubClientFactory = createGitHubClient,
): () => Promise<GitHubClient> {
  let client: Promise<GitHubClient> | undefined;
  return () => {
    client ??= credentials.getGitHubToken().then(factory);
    client.catch(() => (client = undefined));
    return client;
  };
}

/** Refuses to send the token anywhere else. The URL is not shown: it may come from a response header. */
function assertGitHubOrigin(url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = '';
  }
  if (origin !== GITHUB_API_ORIGIN) {
    throw new ProviderApiError('GitHub', `refused to follow a link outside ${GITHUB_API_ORIGIN}`);
  }
}

/** The `rel="next"` target of a Link header (`<url>; rel="next", <url>; rel="last"`), resolved against `base`. */
export function nextPageUrl(link: string | null, base: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!match) continue;
    const [, target = '', params = ''] = match;
    const rel = /;\s*rel="?([^";]*)"?/i.exec(params)?.[1] ?? '';
    if (rel.split(/\s+/).includes('next')) return resolveUrl(target, base);
  }
  return undefined;
}

/** Resolves a URL taken from a response header; a malformed one is a provider error. */
function resolveUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    throw new ProviderApiError('GitHub', 'the response links to a malformed URL');
  }
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
