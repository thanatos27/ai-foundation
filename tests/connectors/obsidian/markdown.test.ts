import { describe, expect, it } from 'vitest';
import {
  appendText,
  createFileText,
  type KnowledgeMeta,
  parseKnowledgeFile,
} from '../../../src/connectors/obsidian/markdown.js';

const FILE_TITLE = 'ファイル名';

function parsed(text: string) {
  const result = parseKnowledgeFile(text, FILE_TITLE);
  if (!result.ok) throw new Error(`unexpectedly malformed: ${result.reason}`);
  return result;
}

describe('parseKnowledgeFile', () => {
  it('reads every known key and the body', () => {
    const text =
      '---\ntitle: CAP定理\ndescription: CAP定理と分散システムでの考え方\narea: personal\n' +
      'tags:\n  - database\n  - distributed-systems\n---\n\nCAP定理では……\n';
    expect(parsed(text)).toEqual({
      ok: true,
      meta: {
        title: 'CAP定理',
        description: 'CAP定理と分散システムでの考え方',
        area: 'personal',
        tags: ['database', 'distributed-systems'],
      },
      body: 'CAP定理では……\n',
    });
  });

  it('uses defaults for missing or null keys and ignores unknown keys', () => {
    const text = '---\ndescription:\naliases: [CAP]\ncreated: 2026-10-15\ncssclasses: { a: 1 }\n---\n本文';
    expect(parsed(text)).toMatchObject({
      meta: { title: FILE_TITLE, description: null, area: null, tags: [] },
      body: '本文',
    });
  });

  it('treats an empty description as none', () => {
    expect(parsed('---\ndescription: ""\n---\n').meta.description).toBeNull();
  });

  it('reads an empty frontmatter', () => {
    expect(parsed('---\n---\nbody\n')).toMatchObject({ meta: { title: FILE_TITLE, tags: [] }, body: 'body\n' });
  });

  it('reads a note without frontmatter as all body', () => {
    const text = '# 見出し\n\n---\n\n本文\n';
    expect(parsed(text)).toEqual({
      ok: true,
      meta: { title: FILE_TITLE, description: null, area: null, tags: [] },
      body: text,
    });
  });

  it('does not take a leading space before --- as frontmatter', () => {
    expect(parsed(' ---\ntitle: x\n---\n').meta.title).toBe(FILE_TITLE);
  });

  it('keeps CRLF line endings in the body', () => {
    expect(parsed('---\r\ntitle: Win\r\n---\r\n\r\nline 1\r\nline 2\r\n')).toMatchObject({
      meta: { title: 'Win' },
      body: 'line 1\r\nline 2\r\n',
    });
  });

  it('accepts a closing line with trailing spaces and a file that ends at the closing line', () => {
    expect(parsed('---\ntitle: a\n---  \nbody').body).toBe('body');
    expect(parsed('---\ntitle: a\n---')).toMatchObject({ meta: { title: 'a' }, body: '' });
  });

  it('removes only one blank line after the frontmatter', () => {
    expect(parsed('---\ntitle: a\n---\n\n\nbody').body).toBe('\nbody');
  });

  it.each([
    ['invalid YAML', '---\ntitle: [unclosed\n---\n', /valid YAML/],
    ['duplicate keys', '---\ntitle: a\ntitle: b\n---\n', /valid YAML/],
    ['no closing line', '---\ntitle: a\nbody\n', /not closed/],
    ['a list as root', '---\n- a\n- b\n---\n', /mapping/],
    ['a scalar as root', '---\njust text\n---\n', /mapping/],
    ['a numeric title', '---\ntitle: 123\n---\n', /title/],
    ['a blank title', '---\ntitle: "  "\n---\n', /title/],
    ['a list description', '---\ndescription: [a]\n---\n', /description/],
    ['an unknown area', '---\narea: study\n---\n', /area/],
    ['a capitalised area', '---\narea: Work\n---\n', /area/],
    ['tags as a single string', '---\ntags: ai\n---\n', /list/],
    ['a numeric tag', '---\ntags: [1]\n---\n', /strings/],
    ['a tag with #', '---\ntags: ["#ai"]\n---\n', /not a valid Obsidian tag/],
    ['a numbers-only tag', '---\ntags: ["1984"]\n---\n', /not a valid Obsidian tag/],
    ['a tag with a space', '---\ntags: ["a b"]\n---\n', /not a valid Obsidian tag/],
  ])('reports %s as malformed', (_label, text, reason) => {
    const result = parseKnowledgeFile(text, FILE_TITLE);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
  });
});

describe('createFileText', () => {
  const meta: KnowledgeMeta = {
    title: 'CAP定理',
    description: 'CAP定理と分散システムでの考え方',
    area: 'personal',
    tags: ['database', 'distributed-systems'],
  };

  it('writes frontmatter, a blank line and the content with LF and a final newline', () => {
    expect(createFileText(meta, 'CAP定理では……')).toBe(
      '---\ntitle: CAP定理\ndescription: CAP定理と分散システムでの考え方\narea: personal\n' +
        'tags:\n  - database\n  - distributed-systems\n---\n\nCAP定理では……\n',
    );
  });

  it('leaves out keys without a value', () => {
    expect(createFileText({ title: 'a', description: null, area: null, tags: [] }, 'x\n')).toBe(
      '---\ntitle: a\n---\n\nx\n',
    );
  });

  it('converts CRLF and CR in the content to LF', () => {
    expect(createFileText({ ...meta, tags: [] }, 'a\r\nb\rc')).toMatch(/\n\na\nb\nc\n$/);
  });

  it.each([
    'RAG: 構成と役割',
    '#hash',
    'yes',
    'null',
    '123',
    '- dash',
    '"quoted"',
    "it's",
    '  spaces  ',
    '[[link]]',
    'a'.repeat(300),
  ])('round-trips the title %j', (title) => {
    const text = createFileText({ ...meta, title, description: `${title} の説明` }, '本文');
    expect(parsed(text).meta).toEqual({ ...meta, title, description: `${title} の説明` });
  });
});

describe('appendText', () => {
  it.each([
    ['an empty file', '', 'new', 'new\n'],
    ['text without a final newline', 'body', 'new', '\n\nnew\n'],
    ['text with a final newline', 'body\n', 'new', '\nnew\n'],
    ['text ending in a blank line', 'body\n\n', 'new', 'new\n'],
    ['text ending in several blank lines', 'body\n\n\n', 'new', 'new\n'],
    ['frontmatter only', '---\ntitle: a\n---\n', 'new', '\nnew\n'],
    ['content with its own final newline', 'body\n', 'new\n', '\nnew\n'],
    ['multi-line content', 'body\n', '- a\n- b', '\n- a\n- b\n'],
  ])('appends to %s', (_label, existing, content, expected) => {
    expect(appendText(existing, content)).toBe(expected);
  });

  it('uses CRLF in a file that has CRLF', () => {
    expect(appendText('---\r\ntitle: a\r\n---\r\n\r\nbody\r\n', 'x\ny\r\nz')).toBe('\r\nx\r\ny\r\nz\r\n');
  });

  it('keeps the content otherwise as given', () => {
    expect(appendText('a\n', '  ## 見出し  ')).toBe('\n  ## 見出し  \n');
  });
});
