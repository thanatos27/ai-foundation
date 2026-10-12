import { describe, expect, it } from 'vitest';
import { KnowledgeSchema } from '../../src/domain/index.js';

const base = { type: 'knowledge', title: 'CAP定理', external_ref: 'notes/cap-theorem.md' };

describe('KnowledgeSchema', () => {
  it.each(['obsidian', 'google_drive'])('accepts source %s', (source) => {
    expect(KnowledgeSchema.safeParse({ ...base, source, area: null, tags: ['distributed-systems'] }).success).toBe(true);
  });

  it.each([
    ['unknown source', { ...base, source: 'notion' }],
    ['missing source', { type: 'knowledge', title: 'a', external_ref: 'x' }],
    ['missing external_ref', { type: 'knowledge', title: 'a', source: 'obsidian' }],
  ])('rejects %s', (_label, input) => {
    expect(KnowledgeSchema.safeParse(input).success).toBe(false);
  });
});
