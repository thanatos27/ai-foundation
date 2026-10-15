import { InputValidationError } from '../../errors.js';

const PREFIX = 'github:';

/**
 * Owner logins: letters, digits and "-", plus "_" for Enterprise Managed Users (`octocat_acme`).
 * Repository names: letters, digits, ".", "_" and "-". The rules only keep the API path intact;
 * GitHub itself answers 404 for anything else that does not exist.
 */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

/** Owner login and repository name addressed by a GitHub project id. */
export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

/** `github:<owner>/<repository>`, from the canonical owner login and repository name GitHub returned. */
export function formatGitHubProjectId(owner: string, repo: string): string {
  return `${PREFIX}${owner}/${repo}`;
}

/** Splits an exact project id. Nothing is normalized: no trimming, case folding, URL or name-only lookup. */
export function parseGitHubProjectId(id: string): GitHubRepositoryRef {
  const parts = id.startsWith(PREFIX) ? id.slice(PREFIX.length).split('/') : [];
  const [owner = '', repo = ''] = parts;
  if (parts.length !== 2 || !OWNER.test(owner) || !REPOSITORY.test(repo) || repo === '.' || repo === '..') {
    const shown = id.length > 200 ? `${id.slice(0, 200)}…` : id;
    throw new InputValidationError(
      `project id must be "github:<owner>/<repository>" as returned by project_list, got ${JSON.stringify(shown)}`,
    );
  }
  return { owner, repo };
}
