import { describe, expect, it } from 'vitest';
import {
  GitHubProjectDetailsSchema,
  ProjectGetInputSchema,
  ProjectGetResultSchema,
  ProjectListFilterSchema,
  ProjectResultSchema,
  ProjectSchema,
} from '../../src/domain/index.js';

const project = {
  id: 'github:thanatos27/physical-ai-robot',
  type: 'project',
  title: 'physical-ai-robot',
  source: 'github',
  external_ref: 'https://github.com/thanatos27/physical-ai-robot',
};

const details = {
  description: 'Physical AI robot project',
  owner: 'thanatos27',
  default_branch: 'main',
  visibility: 'public',
  archived: false,
  fork: false,
  updated_at: '2026-10-15T13:00:00Z',
};

describe('ProjectSchema', () => {
  it.each([
    ['github', 'thanatos27/physical-ai-robot'],
    ['google_drive', 'drive-folder-id'],
  ])('accepts source %s', (source, external_ref) => {
    expect(ProjectSchema.safeParse({ type: 'project', title: 'a', source, external_ref }).success).toBe(true);
  });

  it.each([
    ['unknown source', { type: 'project', title: 'a', source: 'gitlab', external_ref: 'x' }],
    ['missing external_ref', { type: 'project', title: 'a', source: 'github' }],
  ])('rejects %s', (_label, input) => {
    expect(ProjectSchema.safeParse(input).success).toBe(false);
  });
});

describe('ProjectResultSchema', () => {
  it('requires the id', () => {
    expect(ProjectResultSchema.safeParse(project).success).toBe(true);
    const { id: _id, ...withoutId } = project;
    expect(ProjectResultSchema.safeParse(withoutId).success).toBe(false);
  });
});

describe('ProjectListFilterSchema', () => {
  it.each([
    ['an empty filter', {}],
    ['query only', { query: 'physical' }],
    ['owner only', { owner: 'thanatos27' }],
    ['both', { query: 'AI Foundation', owner: 'thanatos27' }],
  ])('accepts %s', (_label, input) => {
    expect(ProjectListFilterSchema.parse(input)).toEqual(input);
  });

  it.each([
    ['an empty query', { query: '' }],
    ['a blank query', { query: '  ' }],
    ['a blank owner', { owner: '\t' }],
    ['page', { page: 2 }],
    ['cursor', { cursor: 'x' }],
    ['limit', { limit: 10 }],
  ])('rejects %s', (_label, input) => {
    expect(ProjectListFilterSchema.safeParse(input).success).toBe(false);
  });
});

describe('ProjectGetInputSchema', () => {
  it('requires an id and nothing else', () => {
    expect(ProjectGetInputSchema.safeParse({ id: project.id }).success).toBe(true);
    expect(ProjectGetInputSchema.safeParse({}).success).toBe(false);
    expect(ProjectGetInputSchema.safeParse({ id: '' }).success).toBe(false);
    expect(ProjectGetInputSchema.safeParse({ id: project.id, readme: true }).success).toBe(false);
  });
});

describe('GitHubProjectDetailsSchema', () => {
  it.each(['public', 'private', 'internal'])('accepts visibility %s', (visibility) => {
    expect(GitHubProjectDetailsSchema.safeParse({ ...details, visibility }).success).toBe(true);
  });

  it('accepts a null description', () => {
    expect(GitHubProjectDetailsSchema.safeParse({ ...details, description: null }).success).toBe(true);
  });

  it.each([
    ['an unknown visibility', { ...details, visibility: 'secret' }],
    ['a date-time without offset', { ...details, updated_at: '2026-10-15T13:00:00' }],
    ['an unknown field', { ...details, stargazers_count: 3 }],
    ['a missing field', { ...details, fork: undefined }],
  ])('rejects %s', (_label, input) => {
    expect(GitHubProjectDetailsSchema.safeParse(input).success).toBe(false);
  });
});

describe('ProjectGetResultSchema', () => {
  it('keeps the project and the details apart', () => {
    expect(ProjectGetResultSchema.safeParse({ project, details }).success).toBe(true);
    expect(ProjectGetResultSchema.safeParse({ project: { ...project, id: undefined }, details }).success).toBe(false);
  });
});
