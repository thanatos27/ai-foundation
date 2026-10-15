import { describe, expect, it } from 'vitest';
import { parseRepository, toDetails, toProject } from '../../../src/connectors/github/mapping.js';
import { GitHubProjectDetailsSchema, ProjectResultSchema } from '../../../src/domain/index.js';
import { ProviderApiError } from '../../../src/errors.js';
import { repoJson } from './fake-client.js';

const map = (data: unknown) => {
  const repo = parseRepository(data);
  return { project: toProject(repo), details: toDetails(repo) };
};

describe('GitHub repository mapping', () => {
  it('maps a repository to a project and its details', () => {
    expect(map(repoJson('thanatos27/physical-ai-robot', { description: 'Physical AI robot project' }))).toEqual({
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
  });

  it('returns only the defined fields, never the rest of the response', () => {
    const { project, details } = map(repoJson('thanatos27/ai-foundation'));
    expect(Object.keys(project).sort()).toEqual(['external_ref', 'id', 'source', 'title', 'type']);
    expect(Object.keys(details).sort()).toEqual([
      'archived',
      'default_branch',
      'description',
      'fork',
      'owner',
      'updated_at',
      'visibility',
    ]);
    const text = JSON.stringify({ project, details });
    for (const leaked of ['TEMP_CLONE_SECRET', 'R_kgDOSECRET', 'avatars', 'permissions', 'stargazers', 'pushed_at']) {
      expect(text).not.toContain(leaked);
    }
    // The numeric repository id is for the access check only.
    expect(text).not.toContain(String(repoJson('thanatos27/ai-foundation').id));
    expect(ProjectResultSchema.safeParse(project).success).toBe(true);
    expect(GitHubProjectDetailsSchema.safeParse(details).success).toBe(true);
  });

  it.each([
    ['public', { visibility: 'public', private: false }],
    ['private', { visibility: 'private', private: true }],
    ['internal', { visibility: 'internal', private: true }],
  ])('keeps %s visibility', (visibility, fields) => {
    expect(map(repoJson('org/repo', fields)).details.visibility).toBe(visibility);
  });

  it.each([
    ['private', true],
    ['public', false],
  ])('falls back to %s from the private flag when visibility is missing', (visibility, isPrivate) => {
    expect(map(repoJson('org/repo', { visibility: undefined, private: isPrivate })).details.visibility).toBe(visibility);
  });

  it('maps archived repositories, forks, organization repositories and null descriptions as they are', () => {
    const { project, details } = map(
      repoJson('Acme-Org/legacy', { archived: true, fork: true, description: null, owner: { login: 'Acme-Org', type: 'Organization' } }),
    );
    expect(project.id).toBe('github:Acme-Org/legacy');
    expect(details).toMatchObject({ owner: 'Acme-Org', archived: true, fork: true, description: null });
  });

  it('keeps a Japanese description as given', () => {
    expect(map(repoJson('a/b', { description: 'ロボット制御の実験' })).details.description).toBe('ロボット制御の実験');
  });

  it.each([
    ['a missing owner', { owner: undefined }, 'owner'],
    ['a missing owner login', { owner: {} }, 'owner.login'],
    ['a numeric name', { name: 42 }, 'name'],
    ['an http URL', { html_url: 'http://github.com/a/b' }, 'html_url'],
    ['an unknown visibility', { visibility: 'secret' }, 'visibility'],
    ['a date without time', { updated_at: '2026-10-15' }, 'updated_at'],
    ['a missing default branch', { default_branch: undefined }, 'default_branch'],
    ['a missing numeric id', { id: 'abc' }, 'id'],
  ])('rejects %s without showing the value', (_label, overrides, path) => {
    const error = (() => {
      try {
        parseRepository(repoJson('a/b', overrides));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error?.message).toBe(`GitHub API error: unexpected repository data: ${path}`);
  });

  it('rejects something that is not an object', () => {
    expect(() => parseRepository('nope')).toThrow('unexpected repository data: (root)');
  });
});
