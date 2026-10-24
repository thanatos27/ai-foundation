import { describe, expect, it } from 'vitest';
import {
  AreaGetInputSchema,
  AreaGetResultSchema,
  AreaListFilterSchema,
  AreaResourceSchema,
  AreaSchema,
} from '../../src/domain/index.js';

const area = {
  id: 'notion:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  type: 'area',
  title: '食事管理',
  source: 'notion',
  external_ref: 'https://www.notion.so/0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
};

describe('AreaResourceSchema', () => {
  it('accepts an area', () => {
    expect(AreaResourceSchema.parse(area)).toEqual(area);
  });

  it.each(['id', 'title', 'external_ref'])('requires a non-empty %s', (field) => {
    expect(AreaResourceSchema.safeParse({ ...area, [field]: '' }).success).toBe(false);
  });

  it('rejects another type or source', () => {
    expect(AreaResourceSchema.safeParse({ ...area, type: 'project' }).success).toBe(false);
    expect(AreaResourceSchema.safeParse({ ...area, source: 'google_drive' }).success).toBe(false);
  });

  it('leaves the work / personal Area of tasks and knowledge unchanged', () => {
    expect(AreaSchema.options).toEqual(['work', 'personal']);
  });
});

describe('AreaListFilterSchema', () => {
  it('accepts an empty filter and a query', () => {
    expect(AreaListFilterSchema.parse({})).toEqual({});
    expect(AreaListFilterSchema.parse({ query: ' 食事 ' })).toEqual({ query: ' 食事 ' });
  });

  it.each(['', '   '])('rejects the blank query %j', (query) => {
    expect(AreaListFilterSchema.safeParse({ query }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(AreaListFilterSchema.safeParse({ limit: 10 }).success).toBe(false);
  });
});

describe('AreaGetInputSchema', () => {
  it('requires an id and nothing else', () => {
    expect(AreaGetInputSchema.parse({ id: area.id })).toEqual({ id: area.id });
    expect(AreaGetInputSchema.safeParse({}).success).toBe(false);
    expect(AreaGetInputSchema.safeParse({ id: '' }).success).toBe(false);
    expect(AreaGetInputSchema.safeParse({ id: area.id, depth: 5 }).success).toBe(false);
  });
});

describe('AreaGetResultSchema', () => {
  it('accepts an area with contents, including empty contents', () => {
    expect(AreaGetResultSchema.parse({ area, content: '# 記録' })).toEqual({ area, content: '# 記録' });
    expect(AreaGetResultSchema.parse({ area, content: '' })).toEqual({ area, content: '' });
  });
});
