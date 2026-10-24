import type { BlockObjectResponse } from '@notionhq/client';
import { describe, expect, it } from 'vitest';
import {
  type BlockNode,
  DEPTH_LIMIT_NOTE,
  expandsChildren,
  renderAreaContent,
  richText,
} from '../../../src/connectors/notion/area-content.js';
import { richTextItem } from './fake-client.js';

const PAGE_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PAGE_URL = 'https://www.notion.so/0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d';

let sequence = 0;

function block(type: string, content: Record<string, unknown> = {}, options: { hasChildren?: boolean; id?: string; inTrash?: boolean } = {}) {
  sequence += 1;
  return {
    object: 'block',
    id: options.id ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    type,
    [type]: content,
    has_children: options.hasChildren ?? false,
    in_trash: options.inTrash ?? false,
  } as unknown as BlockObjectResponse;
}

const text = (type: string, value: string, options: { hasChildren?: boolean } = {}) =>
  block(type, { rich_text: [richTextItem(value)] }, options);

const node = (b: BlockObjectResponse, children?: BlockNode[]): BlockNode => (children ? { block: b, children } : { block: b });

describe('richText', () => {
  it('joins plain text and turns links into Markdown links', () => {
    expect(richText([richTextItem('栄養: '), richTextItem('Knowledge', 'https://example.com/k')] as never)).toBe(
      '栄養: [Knowledge](https://example.com/k)',
    );
  });

  it('makes Notion-relative links absolute', () => {
    expect(richText([richTextItem('レシピ', `/${PAGE_ID.replaceAll('-', '')}`)] as never)).toBe(
      `[レシピ](${PAGE_URL})`,
    );
  });

  it('keeps page mentions as links via their href', () => {
    const mention = { type: 'mention', mention: { type: 'page', page: { id: PAGE_ID } }, plain_text: '食事記録', href: PAGE_URL };
    expect(richText([mention] as never)).toBe(`[食事記録](${PAGE_URL})`);
  });
});

describe('renderAreaContent', () => {
  it('renders the supported table-of-contents blocks', () => {
    const content = renderAreaContent([
      node(text('heading_1', '食事管理')),
      node(text('paragraph', '目次')),
      node(text('heading_2', '記録')),
      node(text('bulleted_list_item', '食事記録')),
      node(text('numbered_list_item', '手順')),
      node(block('to_do', { rich_text: [richTextItem('買い物')], checked: true })),
      node(block('to_do', { rich_text: [richTextItem('献立')], checked: false })),
      node(text('heading_3', 'メモ')),
      node(text('toggle', '詳細')),
      node(text('quote', '引用')),
      node(text('callout', '注意')),
      node(text('heading_4', '小見出し')),
      node(block('divider')),
      node(block('code', { rich_text: [richTextItem('obsidian:Knowledge/栄養.md')], language: 'plain text' })),
    ]);
    expect(content).toBe(
      [
        '# 食事管理',
        '目次',
        '',
        '## 記録',
        '- 食事記録',
        '1. 手順',
        '- [x] 買い物',
        '- [ ] 献立',
        '',
        '### メモ',
        '- 詳細',
        '> 引用',
        '> 注意',
        '',
        '#### 小見出し',
        '---',
        '```plain text',
        'obsidian:Knowledge/栄養.md',
        '```',
      ].join('\n'),
    );
  });

  it('renders child pages, databases and links as links without their contents', () => {
    const content = renderAreaContent([
      node(block('child_page', { title: 'レシピ' }, { id: PAGE_ID, hasChildren: true })),
      node(block('child_page', { title: '' }, { id: PAGE_ID })),
      node(block('child_database', { title: '食事記録DB' }, { id: PAGE_ID })),
      node(block('link_to_page', { type: 'page_id', page_id: PAGE_ID })),
      node(block('link_to_page', { type: 'database_id', database_id: PAGE_ID })),
      node(block('bookmark', { url: 'https://example.com/a', caption: [] })),
      node(block('bookmark', { url: 'https://example.com/b', caption: [richTextItem('資料')] })),
      node(block('embed', { url: 'https://example.com/c', caption: [] })),
      node(block('link_preview', { url: 'https://github.com/thanatos27/ai-foundation' })),
    ]);
    expect(content).toBe(
      [
        `- [レシピ](${PAGE_URL})`,
        `- [Untitled](${PAGE_URL})`,
        `- [食事記録DB](${PAGE_URL}) (Notion database)`,
        `- [Notion page](${PAGE_URL})`,
        `- [Notion database](${PAGE_URL})`,
        '[https://example.com/a](https://example.com/a)',
        '[資料](https://example.com/b)',
        '[https://example.com/c](https://example.com/c)',
        '[https://github.com/thanatos27/ai-foundation](https://github.com/thanatos27/ai-foundation)',
      ].join('\n'),
    );
  });

  it('indents nested blocks and renders columns as their contents', () => {
    const content = renderAreaContent([
      node(text('bulleted_list_item', 'Knowledge', { hasChildren: true }), [
        node(text('bulleted_list_item', '栄養', { hasChildren: true }), [node(text('bulleted_list_item', 'obsidian:Knowledge/栄養.md'))]),
      ]),
      node(block('column_list', {}, { hasChildren: true }), [
        node(block('column', {}, { hasChildren: true }), [node(text('paragraph', '左'))]),
        node(block('column', {}, { hasChildren: true }), [node(text('paragraph', '右'))]),
      ]),
    ]);
    expect(content).toBe(['- Knowledge', '  - 栄養', '    - obsidian:Knowledge/栄養.md', '左', '右'].join('\n'));
  });

  it('keeps multi-line text under its block', () => {
    expect(renderAreaContent([node(text('bulleted_list_item', '一行目\n二行目'))])).toBe('- 一行目\n  二行目');
  });

  it('skips empty paragraphs and blocks in the trash', () => {
    const content = renderAreaContent([
      node(text('paragraph', 'a')),
      node(block('paragraph', { rich_text: [] })),
      node(text('paragraph', 'deleted', {}), undefined),
      node(text('paragraph', 'b')),
    ].map((n, i) => (i === 2 ? { block: { ...n.block, in_trash: true } as BlockObjectResponse } : n)));
    expect(content).toBe('a\nb');
  });

  it('notes unsupported blocks, grouping consecutive ones of the same type', () => {
    const content = renderAreaContent([
      node(block('image')),
      node(block('image')),
      node(block('image')),
      node(block('file')),
      node(block('link_to_page', { type: 'comment_id', comment_id: PAGE_ID })),
      node(text('paragraph', 'after')),
    ]);
    expect(content).toBe(
      [
        '[unsupported Notion block: image x3]',
        '[unsupported Notion block: file]',
        '[unsupported Notion block: link_to_page]',
        'after',
      ].join('\n'),
    );
  });

  it('says that the nested blocks of an unsupported block were not retrieved', () => {
    const content = renderAreaContent([node(block('table', {}, { hasChildren: true })), node(block('synced_block', {}, { hasChildren: true }))]);
    expect(content).toBe(
      [
        '[unsupported Notion block: table; its nested blocks were not retrieved]',
        '[unsupported Notion block: synced_block; its nested blocks were not retrieved]',
      ].join('\n'),
    );
  });

  it('notes children left out by the depth limit', () => {
    const content = renderAreaContent([
      node(text('bulleted_list_item', 'a', { hasChildren: true }), [
        { block: text('bulleted_list_item', 'b', { hasChildren: true }), depthLimited: true },
      ]),
    ]);
    expect(content).toBe(['- a', '  - b', `    ${DEPTH_LIMIT_NOTE}`].join('\n'));
    expect(DEPTH_LIMIT_NOTE).toBe('[nested blocks not retrieved: depth limit 3]');
  });

  it('renders an empty page as empty text', () => {
    expect(renderAreaContent([])).toBe('');
  });
});

describe('expandsChildren', () => {
  it('expands nested lists, toggles and columns that have children', () => {
    for (const type of ['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'paragraph', 'quote', 'callout', 'heading_2', 'column_list', 'column']) {
      expect(expandsChildren(block(type, {}, { hasChildren: true })), type).toBe(true);
    }
    expect(expandsChildren(block('bulleted_list_item'))).toBe(false);
  });

  it('never follows child pages, databases or unsupported blocks', () => {
    for (const type of ['child_page', 'child_database', 'table', 'synced_block', 'link_to_page']) {
      expect(expandsChildren(block(type, {}, { hasChildren: true })), type).toBe(false);
    }
  });
});
