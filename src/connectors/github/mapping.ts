import { z } from 'zod';
import type { GitHubProjectDetails, GitHubVisibility, ProjectResult } from '../../domain/index.js';
import { ProviderApiError } from '../../errors.js';
import { formatGitHubProjectId } from './id.js';

/**
 * The fields AI Foundation reads from a GitHub repository object. Everything else in the response
 * (permissions, clone tokens, owner details...) is dropped here and never reaches a tool result.
 */
const GitHubRepositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  html_url: z.url({ protocol: /^https$/ }),
  description: z.string().nullable(),
  default_branch: z.string().min(1),
  private: z.boolean(),
  visibility: z.enum(['public', 'private', 'internal']).optional(),
  archived: z.boolean(),
  fork: z.boolean(),
  updated_at: z.iso.datetime({ offset: true }),
});

/** A repository as the connector works with it. */
export interface GitHubRepository {
  /** GitHub's numeric repository id: stable across renames and transfers, used for the access check only. */
  repositoryId: number;
  owner: string;
  name: string;
  url: string;
  description: string | null;
  defaultBranch: string;
  visibility: GitHubVisibility;
  archived: boolean;
  fork: boolean;
  updatedAt: string;
}

/** Reads the defined fields of one repository object; anything unexpected is a provider error (values are not shown). */
export function parseRepository(data: unknown): GitHubRepository {
  const result = GitHubRepositorySchema.safeParse(data);
  if (!result.success) {
    const path = result.error.issues[0]?.path.join('.') || '(root)';
    throw new ProviderApiError('GitHub', `unexpected repository data: ${path}`);
  }
  const repo = result.data;
  return {
    repositoryId: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    url: repo.html_url,
    description: repo.description,
    defaultBranch: repo.default_branch,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    archived: repo.archived,
    fork: repo.fork,
    updatedAt: repo.updated_at,
  };
}

/** 1 GitHub repository = 1 project, with the canonical id and URL GitHub currently reports. */
export function toProject(repo: GitHubRepository): ProjectResult {
  return {
    id: formatGitHubProjectId(repo.owner, repo.name),
    type: 'project',
    title: repo.name,
    source: 'github',
    external_ref: repo.url,
  };
}

export function toDetails(repo: GitHubRepository): GitHubProjectDetails {
  return {
    description: repo.description,
    owner: repo.owner,
    default_branch: repo.defaultBranch,
    visibility: repo.visibility,
    archived: repo.archived,
    fork: repo.fork,
    updated_at: repo.updatedAt,
  };
}
