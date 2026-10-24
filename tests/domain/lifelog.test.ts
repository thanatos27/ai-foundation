import { describe, expect, it } from 'vitest';
import {
  LifeLogAppendInputSchema,
  LifeLogCreateInputSchema,
  LifeLogDocumentSchema,
  LifeLogGetInputSchema,
  LifeLogSchema,
} from '../../src/domain/index.js';

const lifelog = {
  id: 'lifelog:2026-10-03-東京散策.md',
  type: 'lifelog',
  date: '2026-10-03',
  title: '東京散策',
  source: 'obsidian',
  external_ref: 'AI Foundation/LifeLog/2026-10-03-東京散策.md',
};

describe('LifeLogSchema', () => {
  it('accepts a life log', () => {
    expect(LifeLogSchema.parse(lifelog)).toEqual(lifelog);
  });

  it.each(['id', 'title', 'external_ref'])('requires a non-empty %s', (field) => {
    expect(LifeLogSchema.safeParse({ ...lifelog, [field]: '' }).success).toBe(false);
  });

  it('rejects another type, source or a date with time', () => {
    expect(LifeLogSchema.safeParse({ ...lifelog, type: 'knowledge' }).success).toBe(false);
    expect(LifeLogSchema.safeParse({ ...lifelog, source: 'google_drive' }).success).toBe(false);
    expect(LifeLogSchema.safeParse({ ...lifelog, date: '2026-10-03T10:00:00+09:00' }).success).toBe(false);
  });
});

describe('LifeLogCreateInputSchema', () => {
  const input = { date: '2026-10-03', title: '東京散策', content: '# 東京散策\n\n浅草へ行った。' };

  it('accepts a date, a title and content, kept as given', () => {
    expect(LifeLogCreateInputSchema.parse({ ...input, title: ' 東京散策 ' })).toEqual({ ...input, title: ' 東京散策 ' });
  });

  it('accepts a leap day in a leap year', () => {
    expect(LifeLogCreateInputSchema.safeParse({ ...input, date: '2028-02-29' }).success).toBe(true);
  });

  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-1', '2026/10/03', '20261003', '2026-10-03T00:00:00Z', ''])(
    'rejects the date %j',
    (date) => {
      expect(LifeLogCreateInputSchema.safeParse({ ...input, date }).success).toBe(false);
    },
  );

  it.each(['title', 'content'])('rejects a blank %s', (field) => {
    expect(LifeLogCreateInputSchema.safeParse({ ...input, [field]: '' }).success).toBe(false);
    expect(LifeLogCreateInputSchema.safeParse({ ...input, [field]: ' \n\t' }).success).toBe(false);
  });

  it.each(['date', 'title', 'content'])('requires %s', (field) => {
    const { [field as keyof typeof input]: _omitted, ...rest } = input;
    expect(LifeLogCreateInputSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects unknown keys (no tags, area or source)', () => {
    expect(LifeLogCreateInputSchema.safeParse({ ...input, tags: ['旅行'] }).success).toBe(false);
    expect(LifeLogCreateInputSchema.safeParse({ ...input, source: 'obsidian' }).success).toBe(false);
  });
});

describe('LifeLogGetInputSchema / LifeLogAppendInputSchema', () => {
  it('accepts an id, and an id with content', () => {
    expect(LifeLogGetInputSchema.parse({ id: lifelog.id })).toEqual({ id: lifelog.id });
    expect(LifeLogAppendInputSchema.parse({ id: lifelog.id, content: '夕食' })).toEqual({ id: lifelog.id, content: '夕食' });
  });

  it('rejects an empty id, blank content and unknown keys', () => {
    expect(LifeLogGetInputSchema.safeParse({ id: '' }).success).toBe(false);
    expect(LifeLogAppendInputSchema.safeParse({ id: lifelog.id, content: '  ' }).success).toBe(false);
    expect(LifeLogGetInputSchema.safeParse({ id: lifelog.id, title: 'x' }).success).toBe(false);
  });
});

describe('LifeLogDocumentSchema', () => {
  it('allows empty content (the body may be emptied in Obsidian)', () => {
    expect(LifeLogDocumentSchema.safeParse({ lifelog, content: '' }).success).toBe(true);
  });
});
