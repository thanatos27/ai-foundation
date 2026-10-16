import type { ProjectListFilter } from '../../domain/index.js';
import type { GitHubRepository } from './mapping.js';

const fold = (text: string) => text.toLowerCase();

/** `owner/repository`, the canonical sort and identity key. */
const fullName = (repo: GitHubRepository) => `${repo.owner}/${repo.name}`;

/** Ordinal comparison: independent of the runtime locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `owner` matches the owner login exactly and `query` is a substring of the name, owner/name or
 * description (a null description counts as ""), both ignoring case. Given together, both must match.
 */
export function matchesFilter(repo: GitHubRepository, { query, owner }: ProjectListFilter): boolean {
  if (owner !== undefined && fold(repo.owner) !== fold(owner)) return false;
  if (query !== undefined) {
    const needle = fold(query);
    return [repo.name, fullName(repo), repo.description ?? ''].some((text) => fold(text).includes(needle));
  }
  return true;
}

/**
 * Sorted by owner/repository ignoring case, then by exact spelling, so the order never depends on
 * the provider. A repository seen twice (pages can shift while paginating) is kept once.
 */
export function sortRepositories(repos: readonly GitHubRepository[]): GitHubRepository[] {
  const unique = new Map<string, GitHubRepository>();
  for (const repo of repos) {
    const key = fold(fullName(repo));
    if (!unique.has(key)) unique.set(key, repo);
  }
  return [...unique.values()].sort(
    (a, b) => compare(fold(fullName(a)), fold(fullName(b))) || compare(fullName(a), fullName(b)),
  );
}
