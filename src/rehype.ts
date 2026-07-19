import path from 'node:path';
import { MARKDOWN_EDITABLE_BLOCK_TAGS } from './editable-tags.ts';
import { createMarker, encodeMarker } from './marker.ts';

const BLOCK_TAGS = new Set(MARKDOWN_EDITABLE_BLOCK_TAGS);
const TURNDOWN_INLINE_TAGS = new Set([
  'a', 'b', 'br', 'code', 'em', 'i', 'li', 'p', 'strong',
]);

interface HastPosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: HastPosition;
}

interface VFileLike {
  path?: string;
  value: unknown;
}

export interface RehypeEditableOptions {
  root: string;
}

export function rehypeEditableBlocks(options: RehypeEditableOptions) {
  return function transform(tree: HastNode, file: VFileLike): void {
    if (!file.path) return;
    const relative = path.relative(options.root, file.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    const source = String(file.value);

    visit(tree, (node) => {
      const tag = node.tagName?.toLowerCase();
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (!tag || !BLOCK_TAGS.has(tag) || start === undefined || end === undefined) return false;
      if (!(node.children ?? []).every((child) => isRoundTripSafeInlineNode(child, source))) return false;
      const original = source.slice(start, end);
      if (!original) return false;

      node.properties ??= {};
      node.properties['data-astro-wysiwyg'] = encodeMarker(createMarker(
        relative.split(path.sep).join('/'),
        start,
        end,
        original,
        'markdown',
        tag,
      ));
      return true;
    });
  };
}

function visit(node: HastNode, callback: (node: HastNode) => boolean | void): void {
  if (callback(node)) return;
  for (const child of node.children ?? []) visit(child, callback);
}

function isRoundTripSafeInlineNode(node: HastNode, source: string): boolean {
  if (node.type === 'text') return true;
  if (node.type !== 'element' || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  if (!TURNDOWN_INLINE_TAGS.has(tag)) return false;
  if (tag === 'a' && !isRoundTripSafeLink(node, source)) return false;
  return (node.children ?? []).every((child) => isRoundTripSafeInlineNode(child, source));
}

function isRoundTripSafeLink(node: HastNode, source: string): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return false;
  const original = source.slice(start, end);
  return !original.startsWith('[') || original.includes('](');
}
