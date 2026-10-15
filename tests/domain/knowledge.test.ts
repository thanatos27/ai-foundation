import { describe, expect, it } from 'vitest';
import {
  KnowledgeAppendInputSchema,
  KnowledgeCreateInputSchema,
  KnowledgeSchema,
  KnowledgeSearchFilterSchema,
} from '../../src/domain/index.js';

const base = { type: 'knowledge', title: 'CAP定理', description: null, external_ref: 'notes/cap-theorem.md' };

describe('KnowledgeSchema', () => {
  it.each(['obsidian', 'google_drive'])('accepts source %s', (source) => {
    expect(KnowledgeSchema.safeParse({ ...base, source, area: null, tags: ['distributed-systems'] }).success).toBe(true);
  });

  it('accepts a description', () => {
    expect(KnowledgeSchema.safeParse({ ...base, source: 'obsidian', description: '分散システム' }).success).toBe(true);
  });

  it.each([
    ['unknown source', { ...base, source: 'notion' }],
    ['missing source', { type: 'knowledge', title: 'a', description: null, external_ref: 'x' }],
    ['missing external_ref', { type: 'knowledge', title: 'a', description: null, source: 'obsidian' }],
    ['missing description', { type: 'knowledge', title: 'a', source: 'obsidian', external_ref: 'x' }],
  ])('rejects %s', (_label, input) => {
    expect(KnowledgeSchema.safeParse(input).success).toBe(false);
  });
});

describe('KnowledgeCreateInputSchema', () => {
  const valid = { title: 'CAP定理', content: 'CAP定理では……' };

  it.each([
    ['minimal', valid],
    ['full', { ...valid, description: '説明', source: 'auto', area: 'personal', tags: ['database'] }],
    ['explicit obsidian', { ...valid, source: 'obsidian' }],
    ['no area', { ...valid, area: null }],
    ['no description', { ...valid, description: null }],
  ])('accepts %s', (_label, input) => {
    expect(KnowledgeCreateInputSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['missing title', { content: 'x' }],
    ['missing content', { title: 'x' }],
    ['blank title', { ...valid, title: '  ' }],
    ['blank content', { ...valid, content: '\n\t ' }],
    ['blank description', { ...valid, description: ' ' }],
    ['google_drive source', { ...valid, source: 'google_drive' }],
    ['unknown area', { ...valid, area: 'study' }],
    ['unknown key', { ...valid, path: 'a.md' }],
  ])('rejects %s', (_label, input) => {
    expect(KnowledgeCreateInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('KnowledgeSearchFilterSchema', () => {
  it.each([{}, { query: 'CAP' }, { area: null }, { area: 'work', tags: ['ai', 'rag'] }])('accepts %j', (filter) => {
    expect(KnowledgeSearchFilterSchema.safeParse(filter).success).toBe(true);
  });

  it.each([{ query: '' }, { query: '  ' }, { source: 'obsidian' }, { tags: [''] }])('rejects %j', (filter) => {
    expect(KnowledgeSearchFilterSchema.safeParse(filter).success).toBe(false);
  });
});

describe('KnowledgeAppendInputSchema', () => {
  it('accepts an id and content', () => {
    expect(KnowledgeAppendInputSchema.safeParse({ id: 'obsidian:a/b.md', content: 'PACELC' }).success).toBe(true);
  });

  it.each([{ id: 'obsidian:a/b.md' }, { id: 'obsidian:a/b.md', content: ' ' }, { content: 'x' }])('rejects %j', (input) => {
    expect(KnowledgeAppendInputSchema.safeParse(input).success).toBe(false);
  });
});
