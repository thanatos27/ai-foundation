import type { GitHubClient } from '../../../src/connectors/github/client.js';

/** A GitHub repository object as the REST API returns it, including fields AI Foundation must drop. */
export function repoJson(
  fullName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { id: number; name: string } {
  const [owner = '', name = ''] = fullName.split('/');
  return {
    id: idOf(fullName),
    node_id: 'R_kgDOSECRET',
    name,
    full_name: fullName,
    owner: { login: owner, id: 1, avatar_url: `https://avatars.githubusercontent.com/${owner}`, type: 'User' },
    html_url: `https://github.com/${fullName}`,
    description: `${name} description`,
    default_branch: 'main',
    private: false,
    visibility: 'public',
    archived: false,
    fork: false,
    updated_at: '2026-10-15T13:00:00Z',
    pushed_at: '2026-10-15T12:00:00Z',
    permissions: { admin: true, push: true, pull: true },
    temp_clone_token: 'TEMP_CLONE_SECRET',
    stargazers_count: 3,
    ...overrides,
  };
}

/** A stable numeric id per full name (case-insensitive, as GitHub names are). */
function idOf(fullName: string): number {
  let hash = 7;
  for (const char of fullName.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_007;
  return hash + 1;
}

/** In-memory GitHub client. `repositories` is what /user/repos returns; `lookup` resolves GET /repos. */
export class FakeGitHubClient implements GitHubClient {
  readonly calls: { method: keyof GitHubClient; args: unknown[] }[] = [];
  repositories: unknown[] = [];
  /** Defaults to a case-insensitive match in `repositories`; tests override it for renames and outsiders. */
  lookup: (owner: string, repo: string) => unknown = (owner, repo) =>
    this.repositories.find(
      (item) => (item as { full_name?: string }).full_name?.toLowerCase() === `${owner}/${repo}`.toLowerCase(),
    );
  listError: Error | undefined;
  getError: Error | undefined;

  async listRepositories(): Promise<unknown[]> {
    this.calls.push({ method: 'listRepositories', args: [] });
    if (this.listError) throw this.listError;
    return this.repositories;
  }

  async getRepository(owner: string, repo: string): Promise<unknown> {
    this.calls.push({ method: 'getRepository', args: [owner, repo] });
    if (this.getError) throw this.getError;
    return this.lookup(owner, repo);
  }
}
