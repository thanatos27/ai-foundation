import type { ProjectGetResult, ProjectListFilter, ProjectResult } from '../../domain/index.js';
import type { ProjectConnector } from '../types.js';
import type { GitHubClient } from './client.js';
import { projectNotFound } from './errors.js';
import { matchesFilter, sortRepositories } from './filter.js';
import { parseGitHubProjectId } from './id.js';
import { parseRepository, toDetails, toProject } from './mapping.js';

export interface GitHubProjectConnectorOptions {
  /** Resolves the API client; called on every operation (memoize it). */
  client: () => Promise<GitHubClient>;
}

/**
 * Project connector for GitHub: 1 repository = 1 project. Projects are discovered from GitHub on every
 * call (no registry or cache), and the token's repository list is the access boundary of both tools.
 */
export class GitHubProjectConnector implements ProjectConnector {
  constructor(private readonly options: GitHubProjectConnectorOptions) {}

  async list(filter: ProjectListFilter): Promise<ProjectResult[]> {
    const repositories = await this.discover();
    return sortRepositories(repositories.filter((repo) => matchesFilter(repo, filter))).map(toProject);
  }

  /**
   * Resolves the exact id directly (GitHub redirects renamed and transferred repositories), then requires
   * the repository to be in the token's repository list: a public repository outside it is not found either.
   */
  async get(id: string): Promise<ProjectGetResult> {
    const { owner, repo } = parseGitHubProjectId(id);
    const api = await this.options.client();
    const repository = parseRepository(await api.getRepository(owner, repo));
    const discovered = await this.discover(api);
    // Compared by GitHub's numeric id: unaffected by case, renames and transfers.
    if (!discovered.some((candidate) => candidate.repositoryId === repository.repositoryId)) {
      throw projectNotFound(id);
    }
    return { project: toProject(repository), details: toDetails(repository) };
  }

  private async discover(api?: GitHubClient) {
    const client = api ?? (await this.options.client());
    return (await client.listRepositories()).map(parseRepository);
  }
}
