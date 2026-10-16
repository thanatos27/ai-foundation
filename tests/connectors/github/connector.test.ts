import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubProjectConnector } from '../../../src/connectors/github/connector.js';
import { projectNotFound } from '../../../src/connectors/github/errors.js';
import { CredentialError, InputValidationError, NotFoundError, ProviderApiError } from '../../../src/errors.js';
import { FakeGitHubClient, repoJson } from './fake-client.js';

let api: FakeGitHubClient;
let connector: GitHubProjectConnector;

const repositories = () => [
  repoJson('thanatos27/physical-ai-robot', { description: 'Physical AI robot project' }),
  repoJson('thanatos27/ai-foundation', { description: null }),
  repoJson('thanatos27/secret-lab', { private: true, visibility: 'private' }),
  repoJson('Acme-Org/enterprise-tools', { private: true, visibility: 'internal', owner: { login: 'Acme-Org' } }),
  repoJson('thanatos27/old-archive', { archived: true }),
  repoJson('thanatos27/forked-lib', { fork: true }),
];

beforeEach(() => {
  api = new FakeGitHubClient();
  api.repositories = repositories().reverse();
  connector = new GitHubProjectConnector({ client: async () => api });
});

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('GitHubProjectConnector.list', () => {
  it('lists every repository of every kind, sorted by owner/repository', async () => {
    expect(ids(await connector.list({}))).toEqual([
      'github:Acme-Org/enterprise-tools',
      'github:thanatos27/ai-foundation',
      'github:thanatos27/forked-lib',
      'github:thanatos27/old-archive',
      'github:thanatos27/physical-ai-robot',
      'github:thanatos27/secret-lab',
    ]);
  });

  it('returns the five project fields only', async () => {
    const [first] = await connector.list({ owner: 'acme-org' });
    expect(first).toEqual({
      id: 'github:Acme-Org/enterprise-tools',
      type: 'project',
      title: 'enterprise-tools',
      source: 'github',
      external_ref: 'https://github.com/Acme-Org/enterprise-tools',
    });
  });

  it('filters by query, owner and both', async () => {
    expect(ids(await connector.list({ query: 'ROBOT' }))).toEqual(['github:thanatos27/physical-ai-robot']);
    expect(ids(await connector.list({ query: 'robot project' }))).toEqual(['github:thanatos27/physical-ai-robot']);
    expect(ids(await connector.list({ owner: 'ACME-ORG' }))).toEqual(['github:Acme-Org/enterprise-tools']);
    expect(ids(await connector.list({ query: 'tools', owner: 'thanatos27' }))).toEqual([]);
    expect(ids(await connector.list({ query: 'lab', owner: 'thanatos27' }))).toEqual(['github:thanatos27/secret-lab']);
  });

  it('gives the same order whatever order GitHub returns', async () => {
    const first = ids(await connector.list({}));
    api.repositories = [...api.repositories].sort(() => 0.5 - Math.random());
    expect(ids(await connector.list({}))).toEqual(first);
  });

  it('reads GitHub again on every call (no cache)', async () => {
    expect(await connector.list({ query: 'physical' })).toHaveLength(1);
    api.repositories = [repoJson('thanatos27/physical-ai-robot-v2')];
    expect(ids(await connector.list({ query: 'physical' }))).toEqual(['github:thanatos27/physical-ai-robot-v2']);
    expect(api.calls.filter((call) => call.method === 'listRepositories')).toHaveLength(2);
  });

  it('fails as a whole when one repository has unexpected data', async () => {
    api.repositories = [...api.repositories, { name: 'broken' }];
    await expect(connector.list({})).rejects.toBeInstanceOf(ProviderApiError);
  });

  it('passes client errors through', async () => {
    api.listError = new ProviderApiError('GitHub', 'HTTP 502');
    await expect(connector.list({})).rejects.toBe(api.listError);
  });
});

describe('GitHubProjectConnector.get', () => {
  it('gets a project and its details by exact id', async () => {
    const result = await connector.get('github:thanatos27/physical-ai-robot');
    expect(result).toEqual({
      project: {
        id: 'github:thanatos27/physical-ai-robot',
        type: 'project',
        title: 'physical-ai-robot',
        source: 'github',
        external_ref: 'https://github.com/thanatos27/physical-ai-robot',
      },
      details: {
        description: 'Physical AI robot project',
        owner: 'thanatos27',
        default_branch: 'main',
        visibility: 'public',
        archived: false,
        fork: false,
        updated_at: '2026-10-15T13:00:00Z',
      },
    });
    expect(api.calls).toEqual([
      { method: 'getRepository', args: ['thanatos27', 'physical-ai-robot'] },
      { method: 'listRepositories', args: [] },
    ]);
  });

  it.each(['physical-ai-robot', 'thanatos27/physical-ai-robot', 'github:physical', 'github:a/b c'])(
    'rejects %s before touching credentials or GitHub',
    async (id) => {
      let resolved = false;
      const strict = new GitHubProjectConnector({
        client: async () => {
          resolved = true;
          return api;
        },
      });
      await expect(strict.get(id)).rejects.toBeInstanceOf(InputValidationError);
      expect(resolved).toBe(false);
    },
  );

  it('returns the current canonical id after a rename or transfer', async () => {
    const moved = repoJson('new-owner/new-name');
    api.repositories = [moved];
    api.lookup = (owner, repo) => (`${owner}/${repo}` === 'thanatos27/old-name' ? moved : undefined);
    const { project, details } = await connector.get('github:thanatos27/old-name');
    expect(project).toMatchObject({
      id: 'github:new-owner/new-name',
      title: 'new-name',
      external_ref: 'https://github.com/new-owner/new-name',
    });
    expect(details.owner).toBe('new-owner');
  });

  it('returns the canonical spelling for an id that differs only in case', async () => {
    const { project } = await connector.get('github:THANATOS27/AI-FOUNDATION');
    expect(project.id).toBe('github:thanatos27/ai-foundation');
  });

  it('reports a public repository outside the token’s repository list as not found', async () => {
    api.lookup = () => repoJson('octocat/Hello-World');
    const error = await connector.get('github:octocat/Hello-World').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error?.message).toBe(projectNotFound('github:octocat/Hello-World').message);
  });

  it('matches the repository list by numeric id, not by name', async () => {
    // Same name as a listed repository, but a different repository (e.g. recreated after a transfer).
    api.lookup = () => repoJson('thanatos27/ai-foundation', { id: 999 });
    await expect(connector.get('github:thanatos27/ai-foundation')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not list repositories when the repository is not found', async () => {
    api.getError = projectNotFound('github:thanatos27/missing');
    await expect(connector.get('github:thanatos27/missing')).rejects.toBe(api.getError);
    expect(api.calls.map((call) => call.method)).toEqual(['getRepository']);
  });

  it('returns nothing when the repository list cannot be read', async () => {
    api.listError = new ProviderApiError('GitHub', 'HTTP 502');
    await expect(connector.get('github:thanatos27/ai-foundation')).rejects.toBe(api.listError);
  });

  it('passes credential errors through', async () => {
    const failing = new GitHubProjectConnector({
      client: async () => {
        throw new CredentialError('GitHub credential is not configured: set GITHUB_TOKEN');
      },
    });
    await expect(failing.get('github:a/b')).rejects.toBeInstanceOf(CredentialError);
    await expect(failing.list({})).rejects.toBeInstanceOf(CredentialError);
  });

  it('reflects changes made on GitHub on the next call', async () => {
    expect((await connector.get('github:thanatos27/ai-foundation')).details.description).toBeNull();
    api.repositories = repositories().map((repo) =>
      repo.name === 'ai-foundation' ? { ...repo, description: 'AI Foundation', archived: true } : repo,
    );
    expect((await connector.get('github:thanatos27/ai-foundation')).details).toMatchObject({
      description: 'AI Foundation',
      archived: true,
    });
    // Removed from the token's repository access while still public: GitHub still serves it directly.
    const stillPublic = repoJson('thanatos27/ai-foundation');
    api.lookup = () => stillPublic;
    api.repositories = [];
    await expect(connector.get('github:thanatos27/ai-foundation')).rejects.toBeInstanceOf(NotFoundError);
  });
});
