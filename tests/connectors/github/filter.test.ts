import { describe, expect, it } from 'vitest';
import { matchesFilter, sortRepositories } from '../../../src/connectors/github/filter.js';
import { type GitHubRepository, parseRepository } from '../../../src/connectors/github/mapping.js';
import type { ProjectListFilter } from '../../../src/domain/index.js';
import { repoJson } from './fake-client.js';

const repo = (fullName: string, overrides: Record<string, unknown> = {}) => parseRepository(repoJson(fullName, overrides));
const names = (repos: GitHubRepository[]) => repos.map((r) => `${r.owner}/${r.name}`);

const repos = [
  repo('thanatos27/physical-ai-robot', { description: 'Physical AI robot project' }),
  repo('thanatos27/ai-foundation', { description: 'MCP server for personal sources of truth' }),
  repo('Acme-Org/Robot-Arm', { description: null }),
  repo('thanatos2/notes', { description: '日本語の説明: ロボット' }),
];
const matching = (filter: ProjectListFilter) => names(repos.filter((r) => matchesFilter(r, filter)));

describe('matchesFilter', () => {
  it('matches everything with an empty filter', () => {
    expect(matching({})).toHaveLength(4);
  });

  it.each([
    ['the repository name', 'physical', ['thanatos27/physical-ai-robot']],
    ['owner/repository', 'thanatos27/ai', ['thanatos27/ai-foundation']],
    ['the owner part of owner/repository', 'acme-org/', ['Acme-Org/Robot-Arm']],
    ['the description', 'mcp server', ['thanatos27/ai-foundation']],
    ['a Japanese description', 'ロボット', ['thanatos2/notes']],
    ['any case', 'ROBOT', ['thanatos27/physical-ai-robot', 'Acme-Org/Robot-Arm']],
  ])('matches a query in %s', (_label, query, expected) => {
    expect(matching({ query })).toEqual(expected);
  });

  it('treats a null description as empty and does not normalize spaces or hyphens', () => {
    expect(matching({ query: 'null' })).toEqual([]);
    expect(matching({ query: 'AI Foundation' })).toEqual([]);
    expect(matching({ query: 'ai-foundation' })).toEqual(['thanatos27/ai-foundation']);
  });

  it('matches the owner exactly, ignoring case, for users and organizations alike', () => {
    expect(matching({ owner: 'THANATOS27' })).toEqual(['thanatos27/physical-ai-robot', 'thanatos27/ai-foundation']);
    expect(matching({ owner: 'acme-org' })).toEqual(['Acme-Org/Robot-Arm']);
    expect(matching({ owner: 'thanatos' })).toEqual([]);
    expect(matching({ owner: 'thanatos2' })).toEqual(['thanatos2/notes']);
  });

  it('requires both query and owner when both are given', () => {
    expect(matching({ query: 'robot', owner: 'thanatos27' })).toEqual(['thanatos27/physical-ai-robot']);
    expect(matching({ query: 'notes', owner: 'thanatos27' })).toEqual([]);
  });
});

describe('sortRepositories', () => {
  it('sorts by owner/repository ignoring case, whatever order the provider used', () => {
    const shuffled = [repos[1]!, repos[3]!, repos[0]!, repos[2]!];
    const expected = ['Acme-Org/Robot-Arm', 'thanatos2/notes', 'thanatos27/ai-foundation', 'thanatos27/physical-ai-robot'];
    expect(names(sortRepositories(shuffled))).toEqual(expected);
    expect(names(sortRepositories([...shuffled].reverse()))).toEqual(expected);
  });

  it('compares "/" before letters and digits, not by locale', () => {
    expect(names(sortRepositories([repo('ab/x'), repo('a/z'), repo('a-b/y')]))).toEqual(['a-b/y', 'a/z', 'ab/x']);
  });

  it('keeps a repository seen twice only once', () => {
    expect(names(sortRepositories([repos[0]!, repos[1]!, repos[0]!]))).toEqual([
      'thanatos27/ai-foundation',
      'thanatos27/physical-ai-robot',
    ]);
  });

  it('does not modify its input', () => {
    const input = [repos[1]!, repos[0]!];
    sortRepositories(input);
    expect(input).toEqual([repos[1], repos[0]]);
  });
});
