import { beforeAll, describe, expect, it } from 'vitest';
import { createGitHubClient, lazyGitHubClient } from '../../src/connectors/github/client.js';
import { GitHubProjectConnector } from '../../src/connectors/github/connector.js';
import type { ProjectResult } from '../../src/domain/index.js';
import { CredentialError, NotFoundError } from '../../src/errors.js';
import { credentials, enabled, hasEnv } from './setup.js';

/**
 * Read-only: these tests only list and get repositories, never write to GitHub.
 * AI_FOUNDATION_IT_GITHUB_REPO (default thanatos27/ai-foundation) must be a public repository the token can access.
 * AI_FOUNDATION_IT_GITHUB_PRIVATE_REPO (optional) is a private one; its name is personal, so it is not committed.
 * AI_FOUNDATION_IT_GITHUB_OUTSIDE_REPO (default octocat/Hello-World) is a public repository outside the token's access.
 */
const run = enabled && hasEnv('GITHUB_TOKEN');
const publicRepo = process.env.AI_FOUNDATION_IT_GITHUB_REPO?.trim() || 'thanatos27/ai-foundation';
const privateRepo = process.env.AI_FOUNDATION_IT_GITHUB_PRIVATE_REPO?.trim() || undefined;
const outsideRepo = process.env.AI_FOUNDATION_IT_GITHUB_OUTSIDE_REPO?.trim() || 'octocat/Hello-World';
const [publicOwner = ''] = publicRepo.split('/');

describe.runIf(run)('GitHub projects (real API)', () => {
  let connector: GitHubProjectConnector;
  let all: ProjectResult[];

  beforeAll(async () => {
    connector = new GitHubProjectConnector({ client: lazyGitHubClient(credentials) });
    all = await connector.list({});
  });

  const ids = (items: ProjectResult[]) => items.map((item) => item.id.toLowerCase());

  it('lists the repositories the token can access, sorted by owner/repository', () => {
    expect(all.length).toBeGreaterThan(0);
    expect(ids(all)).toContain(`github:${publicRepo}`.toLowerCase());
    const keys = all.map((item) => item.id.toLowerCase());
    expect(keys).toEqual([...keys].sort());
    for (const item of all) {
      expect(Object.keys(item).sort()).toEqual(['external_ref', 'id', 'source', 'title', 'type']);
      expect(item.external_ref).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    }
  });

  it('searches by query, ignoring case', async () => {
    const [, name = ''] = publicRepo.split('/');
    for (const query of [name, name.toUpperCase(), publicRepo]) {
      expect(ids(await connector.list({ query }))).toContain(`github:${publicRepo}`.toLowerCase());
    }
  });

  it('narrows by owner, ignoring case', async () => {
    const owned = await connector.list({ owner: publicOwner.toUpperCase() });
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.every((item) => item.id.toLowerCase().startsWith(`github:${publicOwner.toLowerCase()}/`))).toBe(true);
    expect(ids(owned)).toContain(`github:${publicRepo}`.toLowerCase());
  });

  it('gets a public repository with its details by exact id', async () => {
    const id = all.find((item) => item.id.toLowerCase() === `github:${publicRepo}`.toLowerCase())!.id;
    const { project, details } = await connector.get(id);
    expect(project).toMatchObject({ id, type: 'project', source: 'github' });
    expect(details).toMatchObject({ visibility: 'public', archived: expect.any(Boolean), fork: expect.any(Boolean) });
    expect(details.default_branch).toBeTruthy();
    expect(details.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(details.description === null || typeof details.description === 'string').toBe(true);
  });

  it.runIf(privateRepo)('lists and gets a private repository', async () => {
    const id = `github:${privateRepo}`;
    expect(ids(all)).toContain(id.toLowerCase());
    expect((await connector.get(id)).details.visibility).toBe('private');
  });

  it('reports a missing repository as not found', async () => {
    await expect(connector.get(`github:${publicOwner}/af-it-missing-${Date.now()}`)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports a public repository outside the token’s access as not found', async (context) => {
    if (ids(all).includes(`github:${outsideRepo}`.toLowerCase())) context.skip();
    await expect(connector.get(`github:${outsideRepo}`)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an invalid token without showing it', async () => {
    const token = 'github_pat_af_it_invalid_0000000000000000';
    const invalid = new GitHubProjectConnector({ client: async () => createGitHubClient(token) });
    const error = await invalid.list({}).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(CredentialError);
    expect(error?.message).not.toContain(token);
  });
});
