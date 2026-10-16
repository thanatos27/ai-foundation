import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubClient,
  GITHUB_API_VERSION,
  type GitHubClient,
  lazyGitHubClient,
  nextPageUrl,
} from '../../../src/connectors/github/client.js';
import { EnvCredentialProvider } from '../../../src/credentials/env.js';
import { CredentialError, NotFoundError, ProviderApiError } from '../../../src/errors.js';
import { repoJson } from './fake-client.js';

const TOKEN = 'ghp_TESTSECRET0000';
const API = 'https://api.github.com';
const LIST = `${API}/user/repos?per_page=100&visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&direction=asc`;
const page = (n: number) => `${API}/user/repos?per_page=100&page=${n}`;

type Route = Response | Error | (() => Response | Promise<Response>);

/** A fetch that answers from `routes` by exact URL and records every request. */
function fakeFetch(routes: Record<string, Route>) {
  const requests: { url: string; headers: Record<string, string>; method: string | undefined; redirect: string | undefined }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      method: init?.method,
      redirect: init?.redirect,
    });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected request ${url}`);
    if (route instanceof Error) throw route;
    return typeof route === 'function' ? route() : route.clone();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const linkNext = (url: string) => ({ link: `<${url}>; rel="next", <${page(9)}>; rel="last"` });

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error, 'expected the call to fail').toBeInstanceOf(Error);
  // Common assertion: no message ever carries the token.
  expect(error!.message).not.toContain(TOKEN);
  expect(JSON.stringify(error!.cause ?? null)).not.toContain(TOKEN);
  return error!;
}

function client(routes: Record<string, Route>, options: { timeoutMs?: number } = {}) {
  const fake = fakeFetch(routes);
  return { api: createGitHubClient(TOKEN, { fetch: fake.fetch, ...options }), requests: fake.requests };
}

describe('createGitHubClient', () => {
  it('sends GET requests with the token, the pinned API version and a user agent, following no redirect by itself', async () => {
    const { api, requests } = client({ [`${API}/repos/thanatos27/ai-foundation`]: json(repoJson('thanatos27/ai-foundation')) });
    await api.getRepository('thanatos27', 'ai-foundation');
    expect(requests).toEqual([
      {
        url: `${API}/repos/thanatos27/ai-foundation`,
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${TOKEN}`,
          'user-agent': 'ai-foundation',
          'x-github-api-version': GITHUB_API_VERSION,
        },
      },
    ]);
    expect(GITHUB_API_VERSION).toBe('2022-11-28');
  });

  it('lists every page by following the Link header to the end', async () => {
    const { api, requests } = client({
      [LIST]: json([repoJson('a/one'), repoJson('a/two')], { headers: linkNext(page(2)) }),
      [page(2)]: json([repoJson('b/three')], { headers: linkNext(page(3)) }),
      [page(3)]: json([repoJson('c/four')], { headers: { link: `<${page(1)}>; rel="first", <${page(2)}>; rel="prev"` } }),
    });
    const items = (await api.listRepositories()) as { full_name: string }[];
    expect(items.map((item) => item.full_name)).toEqual(['a/one', 'a/two', 'b/three', 'c/four']);
    expect(requests.map((request) => request.url)).toEqual([LIST, page(2), page(3)]);
    expect(requests.every((request) => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('returns an empty list when there are no repositories', async () => {
    await expect(client({ [LIST]: json([]) }).api.listRepositories()).resolves.toEqual([]);
  });

  it.each([
    ['HTTP 500', () => json({ message: 'boom' }, { status: 500 })],
    ['a network error', new TypeError('fetch failed')],
    ['invalid JSON', () => new Response('<html>', { status: 200 })],
    ['a body that is not an array', () => json({ items: [] })],
    ['a rate limit', () => json({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })],
  ])('fails without a partial result when a later page fails with %s', async (_label, route) => {
    const { api } = client({
      [LIST]: json([repoJson('a/one')], { headers: linkNext(page(2)) }),
      [page(2)]: route,
    });
    expect(await failure(api.listRepositories())).toBeInstanceOf(ProviderApiError);
  });

  it('does not send the token to a pagination link outside api.github.com', async () => {
    const { api, requests } = client({
      [LIST]: json([repoJson('a/one')], { headers: linkNext('https://evil.example/user/repos?page=2') }),
    });
    const error = await failure(api.listRepositories());
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('GitHub API error: refused to follow a link outside https://api.github.com');
    expect(requests.map((request) => request.url)).toEqual([LIST]);
  });

  it('refuses a pagination link that loops back', async () => {
    const { api } = client({
      [LIST]: json([], { headers: linkNext(page(2)) }),
      [page(2)]: json([], { headers: linkNext(page(2)) }),
    });
    expect((await failure(api.listRepositories())).message).toContain('links back to a page already read');
  });

  it('follows a same-origin redirect of a renamed repository, with the token', async () => {
    const { api, requests } = client({
      [`${API}/repos/thanatos27/old-name`]: new Response(null, { status: 301, headers: { location: `${API}/repositories/123` } }),
      [`${API}/repositories/123`]: json(repoJson('thanatos27/new-name')),
    });
    await expect(api.getRepository('thanatos27', 'old-name')).resolves.toMatchObject({ full_name: 'thanatos27/new-name' });
    expect(requests.map((request) => [request.url, request.headers.authorization])).toEqual([
      [`${API}/repos/thanatos27/old-name`, `Bearer ${TOKEN}`],
      [`${API}/repositories/123`, `Bearer ${TOKEN}`],
    ]);
  });

  it('resolves a relative redirect location against the API origin', async () => {
    const { api } = client({
      [`${API}/repos/a/b`]: new Response(null, { status: 307, headers: { location: '/repositories/9' } }),
      [`${API}/repositories/9`]: json(repoJson('a/c')),
    });
    await expect(api.getRepository('a', 'b')).resolves.toMatchObject({ full_name: 'a/c' });
  });

  it.each([
    ['another origin', { location: 'https://evil.example/repositories/123' }, 'refused to follow a link outside'],
    ['http', { location: 'http://api.github.com/repositories/123' }, 'refused to follow a link outside'],
    ['no location', {} as Record<string, string>, 'HTTP 301 without a redirect location'],
  ])('does not follow a redirect to %s', async (_label, headers, message) => {
    const { api, requests } = client({ [`${API}/repos/a/b`]: new Response(null, { status: 301, headers }) });
    expect((await failure(api.getRepository('a', 'b'))).message).toContain(message);
    expect(requests).toHaveLength(1);
  });

  it('stops after three redirects', async () => {
    const hop = (n: number) => new Response(null, { status: 301, headers: { location: `${API}/repositories/${n}` } });
    const { api } = client({
      [`${API}/repos/a/b`]: hop(1),
      [`${API}/repositories/1`]: hop(2),
      [`${API}/repositories/2`]: hop(3),
      [`${API}/repositories/3`]: hop(4),
    });
    expect((await failure(api.getRepository('a', 'b'))).message).toBe('GitHub API error: too many redirects');
  });

  it('encodes the path segments', async () => {
    const { api, requests } = client({ [`${API}/repos/a/b.c`]: json(repoJson('a/b.c')) });
    await api.getRepository('a', 'b.c');
    expect(requests[0]?.url).toBe(`${API}/repos/a/b.c`);
  });

  it.each([
    [401, 'list', CredentialError],
    [401, 'get', CredentialError],
    [404, 'get', NotFoundError],
    [403, 'get', NotFoundError],
    [403, 'list', CredentialError],
    [502, 'get', ProviderApiError],
    [503, 'list', ProviderApiError],
  ] as const)('maps HTTP %i of %s', async (status, kind, type) => {
    const response = () => json({ message: 'Bad credentials' }, { status });
    const { api } = client({ [LIST]: response, [`${API}/repos/a/b`]: response });
    const error = await failure(kind === 'list' ? api.listRepositories() : api.getRepository('a', 'b'));
    expect(error).toBeInstanceOf(type);
    expect(error.message).not.toContain('Bad credentials');
  });

  it('fails on a rate limit without retrying', async () => {
    const { api, requests } = client({
      [LIST]: () => json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.UTC(2026, 9, 15, 13) / 1000) } }),
    });
    const error = await failure(api.listRepositories());
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('GitHub API error: rate limit exceeded; resets at 2026-10-15T13:00:00Z');
    expect(requests).toHaveLength(1);
  });

  it('reports a network error by code only', async () => {
    const cause = Object.assign(new Error(`connect ECONNRESET with ${TOKEN}`), { code: 'ECONNRESET' });
    const { api } = client({ [LIST]: new TypeError('fetch failed', { cause }) });
    const error = await failure(api.listRepositories());
    expect(error.message).toBe('GitHub API error: could not reach api.github.com (ECONNRESET)');
  });

  it('gives up on a request without a response in time', async () => {
    const hanging = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const api = createGitHubClient(TOKEN, { fetch: hanging as typeof globalThis.fetch, timeoutMs: 20 });
    const error = await failure(api.getRepository('a', 'b'));
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error.message).toBe('GitHub API error: no response within 1 seconds');
  });

  it('rejects a 200 response that is not JSON', async () => {
    const { api } = client({ [`${API}/repos/a/b`]: () => new Response('', { status: 200 }) });
    expect((await failure(api.getRepository('a', 'b'))).message).toBe('GitHub API error: the response is not valid JSON');
  });

  it.each([
    ['a newline', 'ghp_abc\ndef'],
    ['a space', 'ghp_abc def'],
    ['non-ASCII', 'ghp_abcé'],
  ])('refuses a token with %s before sending anything, without showing it', (_label, token) => {
    const fake = fakeFetch({});
    let error: unknown;
    try {
      createGitHubClient(token, { fetch: fake.fetch });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as Error).message).toBe('Credential error: GITHUB_TOKEN contains characters that cannot be sent in an HTTP header');
    expect((error as Error).message).not.toContain('ghp_abc');
    expect(fake.requests).toEqual([]);
  });
});

describe('nextPageUrl', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    [`<${page(2)}>; rel="next"`, page(2)],
    [`<${page(1)}>; rel="prev", <${page(3)}>; rel="next"`, page(3)],
    [`<${page(3)}>; rel="last"`, undefined],
    [`<${page(3)}>; rel="next last"`, page(3)],
    [`</user/repos?page=2>; rel=next`, `${API}/user/repos?page=2`],
  ])('reads %s', (link, expected) => {
    expect(nextPageUrl(link, LIST)).toBe(expected);
  });
});

describe('lazyGitHubClient', () => {
  it('creates the client once, from the credential provider token', async () => {
    const created = {} as GitHubClient;
    const factory = vi.fn(() => created);
    const get = lazyGitHubClient(new EnvCredentialProvider({ GITHUB_TOKEN: TOKEN }), factory);

    expect(factory).not.toHaveBeenCalled();
    await expect(get()).resolves.toBe(created);
    await expect(get()).resolves.toBe(created);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(TOKEN);
  });

  it('looks the token up again after a failure', async () => {
    const env: Record<string, string> = {};
    const get = lazyGitHubClient(new EnvCredentialProvider(env), () => ({}) as GitHubClient);
    await expect(get()).rejects.toThrow('Credential error: GitHub credential is not configured: set GITHUB_TOKEN');
    env.GITHUB_TOKEN = TOKEN;
    await expect(get()).resolves.toBeDefined();
  });

  it('never reads the environment itself', async () => {
    vi.stubEnv('GITHUB_TOKEN', TOKEN);
    try {
      await expect(lazyGitHubClient(new EnvCredentialProvider({}))()).rejects.toBeInstanceOf(CredentialError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports a token that cannot be sent as a credential error', async () => {
    const get = lazyGitHubClient(new EnvCredentialProvider({ GITHUB_TOKEN: 'ghp_a b' }));
    await expect(get()).rejects.toBeInstanceOf(CredentialError);
  });
});
