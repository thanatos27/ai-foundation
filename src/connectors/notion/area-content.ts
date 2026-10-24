import type { BlockObjectResponse, RichTextItemResponse } from '@notionhq/client';
import { notionPageUrl } from './id.js';

/**
 * Converts the blocks of an area page into Markdown-like text for an LLM. Pure: the connector
 * fetches the blocks (§11.1 of the plan) and this module only renders what it was given.
 */

/** How many block levels of an area page are read; the page's own blocks are level 1. */
export const AREA_CONTENT_DEPTH = 3;

/** Title Notion shows for a page without one. */
export const UNTITLED = 'Untitled';

/** A block with the children the connector fetched for it. */
export interface BlockNode {
  block: BlockObjectResponse;
  /** Present when the children were fetched. */
  children?: BlockNode[];
  /** The block has children that were not fetched because of the depth limit. */
  depthLimited?: boolean;
}

/** Blocks whose children are fetched and rendered (nested lists, toggles, columns, ...). */
const EXPANDED: ReadonlySet<BlockObjectResponse['type']> = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'column_list',
  'column',
]);

/** Layout blocks: rendered as their children, without a line of their own. */
const TRANSPARENT: ReadonlySet<BlockObjectResponse['type']> = new Set(['column_list', 'column']);

/**
 * Whether the connector should fetch this block's children. Child pages, databases and links are
 * never followed; children of unsupported blocks are not fetched (the note says so).
 */
export function expandsChildren(block: BlockObjectResponse): boolean {
  return block.has_children && EXPANDED.has(block.type);
}

const INDENT = '  ';

export const DEPTH_LIMIT_NOTE = `[nested blocks not retrieved: depth limit ${AREA_CONTENT_DEPTH}]`;

/** The table of contents as text: one line per block, nested blocks indented by two spaces. */
export function renderAreaContent(nodes: readonly BlockNode[]): string {
  const lines = renderNodes(nodes, '');
  // A blank line before each heading, except at the top.
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && /^#{1,4} /.test(line) && out[out.length - 1] !== '') out.push('');
    out.push(line);
  }
  return out.join('\n');
}

function renderNodes(nodes: readonly BlockNode[], indent: string): string[] {
  const lines: string[] = [];
  let unsupported: { type: string; count: number } | undefined;
  const flushUnsupported = () => {
    if (!unsupported) return;
    const suffix = unsupported.count > 1 ? ` x${unsupported.count}` : '';
    lines.push(`${indent}[unsupported Notion block: ${unsupported.type}${suffix}]`);
    unsupported = undefined;
  };

  for (const node of nodes) {
    const { block } = node;
    if (block.in_trash) continue;
    const line = renderBlock(block);

    if (line === undefined) {
      if (block.has_children) {
        flushUnsupported();
        lines.push(`${indent}[unsupported Notion block: ${block.type}; its nested blocks were not retrieved]`);
      } else if (unsupported?.type === block.type) {
        unsupported.count += 1;
      } else {
        flushUnsupported();
        unsupported = { type: block.type, count: 1 };
      }
      continue;
    }
    flushUnsupported();

    const childIndent = TRANSPARENT.has(block.type) ? indent : indent + INDENT;
    // Continuation lines sit under the item's text; a code block keeps its own indent.
    const continuation = block.type === 'code' ? indent : childIndent;
    if (line !== null) lines.push(...line.split('\n').map((text, i) => (i === 0 ? indent : continuation) + text));
    if (node.children) lines.push(...renderNodes(node.children, childIndent));
    if (node.depthLimited) lines.push(`${childIndent}${DEPTH_LIMIT_NOTE}`);
  }
  flushUnsupported();
  return lines;
}

/**
 * The block's own line: `null` for blocks that only hold children (columns, empty paragraphs),
 * `undefined` for unsupported blocks.
 */
function renderBlock(block: BlockObjectResponse): string | null | undefined {
  switch (block.type) {
    case 'heading_1':
      return `# ${richText(block.heading_1.rich_text)}`;
    case 'heading_2':
      return `## ${richText(block.heading_2.rich_text)}`;
    case 'heading_3':
      return `### ${richText(block.heading_3.rich_text)}`;
    case 'heading_4':
      return `#### ${richText(block.heading_4.rich_text)}`;
    case 'paragraph': {
      const text = richText(block.paragraph.rich_text);
      return text === '' ? null : text;
    }
    case 'bulleted_list_item':
      return `- ${richText(block.bulleted_list_item.rich_text)}`;
    case 'numbered_list_item':
      return `1. ${richText(block.numbered_list_item.rich_text)}`;
    case 'to_do':
      return `- [${block.to_do.checked ? 'x' : ' '}] ${richText(block.to_do.rich_text)}`;
    case 'toggle':
      return `- ${richText(block.toggle.rich_text)}`;
    case 'quote':
      return `> ${richText(block.quote.rich_text)}`;
    case 'callout':
      return `> ${richText(block.callout.rich_text)}`;
    case 'column_list':
    case 'column':
      return null;
    case 'divider':
      return '---';
    case 'code':
      return `\`\`\`${block.code.language}\n${richText(block.code.rich_text)}\n\`\`\``;
    case 'child_page':
      return `- [${block.child_page.title || UNTITLED}](${notionPageUrl(block.id)})`;
    case 'child_database':
      return `- [${block.child_database.title || UNTITLED}](${notionPageUrl(block.id)}) (Notion database)`;
    case 'link_to_page': {
      const link = block.link_to_page;
      if (link.type === 'page_id') return `- [Notion page](${notionPageUrl(link.page_id)})`;
      if (link.type === 'database_id') return `- [Notion database](${notionPageUrl(link.database_id)})`;
      return undefined;
    }
    case 'bookmark':
      return link(block.bookmark.url, block.bookmark.caption);
    case 'embed':
      return link(block.embed.url, block.embed.caption);
    case 'link_preview':
      return link(block.link_preview.url, []);
    default:
      return undefined;
  }
}

function link(url: string, caption: RichTextItemResponse[]): string {
  const label = plainText(caption) || url;
  return `[${label}](${absoluteUrl(url)})`;
}

/** Plain text, with links (including page mentions) as `[text](url)`. Formatting is dropped. */
export function richText(items: readonly RichTextItemResponse[]): string {
  return items.map((item) => (item.href ? `[${item.plain_text}](${absoluteUrl(item.href)})` : item.plain_text)).join('');
}

function plainText(items: readonly RichTextItemResponse[]): string {
  return items.map((item) => item.plain_text).join('');
}

/** Links to other Notion pages can come as `/<page-id>`: make them usable outside Notion. */
function absoluteUrl(href: string): string {
  return href.startsWith('/') && !href.startsWith('//') ? `https://www.notion.so${href}` : href;
}
