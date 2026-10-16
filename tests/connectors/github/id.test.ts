import { describe, expect, it } from 'vitest';
import { formatGitHubProjectId, parseGitHubProjectId } from '../../../src/connectors/github/id.js';
import { InputValidationError } from '../../../src/errors.js';

describe('parseGitHubProjectId', () => {
  it.each([
    ['github:thanatos27/physical-ai-robot', 'thanatos27', 'physical-ai-robot'],
    ['github:Thanatos27/AI-Foundation', 'Thanatos27', 'AI-Foundation'],
    ['github:openai/example', 'openai', 'example'],
    ['github:octocat_acme/repo.name_x-y', 'octocat_acme', 'repo.name_x-y'],
    ['github:a/.github', 'a', '.github'],
    ['github:a/...', 'a', '...'],
    [`github:${'a'.repeat(39)}/${'b'.repeat(100)}`, 'a'.repeat(39), 'b'.repeat(100)],
  ])('parses %s', (id, owner, repo) => {
    expect(parseGitHubProjectId(id)).toEqual({ owner, repo });
    expect(formatGitHubProjectId(owner, repo)).toBe(id);
  });

  it.each([
    ['a repository name only', 'physical-ai-robot'],
    ['owner/repository without prefix', 'thanatos27/physical-ai-robot'],
    ['another prefix case', 'GitHub:thanatos27/physical-ai-robot'],
    ['another source', 'google_drive:folder-id'],
    ['a URL', 'https://github.com/thanatos27/physical-ai-robot'],
    ['a prefixed URL', 'github:https://github.com/thanatos27/physical-ai-robot'],
    ['no repository', 'github:thanatos27'],
    ['an empty repository', 'github:thanatos27/'],
    ['an empty owner', 'github:/physical-ai-robot'],
    ['three segments', 'github:a/b/c'],
    ['an owner starting with "-"', 'github:-a/b'],
    ['an owner longer than 39', `github:${'a'.repeat(40)}/b`],
    ['a repository longer than 100', `github:a/${'b'.repeat(101)}`],
    ['a space', 'github:a/b c'],
    ['surrounding spaces', ' github:a/b '],
    ['a trailing newline', 'github:a/b\n'],
    ['non-ASCII', 'github:a/日本語'],
    ['"." as repository', 'github:a/.'],
    ['".." as repository', 'github:a/..'],
    ['an encoded slash', 'github:a/b%2Fc'],
    ['a query string', 'github:a/b?x=1'],
  ])('rejects %s', (_label, id) => {
    expect(() => parseGitHubProjectId(id)).toThrow(InputValidationError);
  });

  it('explains the expected form and shows a long input truncated', () => {
    const error = (() => {
      try {
        parseGitHubProjectId(`x${'y'.repeat(500)}`);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain('project id must be "github:<owner>/<repository>" as returned by project_list');
    expect(error?.message.length).toBeLessThan(400);
  });
});
