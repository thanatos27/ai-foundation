import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '../../src/domain/index.js';

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
