import path from 'node:path';
import { createMarker, encodeMarker } from './marker.ts';

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li']);
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
  'ins', 'kbd', 'li', 'mark', 'p', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
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
      if (!(node.children ?? []).every(isStaticInlineNode)) return false;
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

function isStaticInlineNode(node: HastNode): boolean {
  if (node.type === 'text') return true;
  if (node.type !== 'element' || !node.tagName || !INLINE_TAGS.has(node.tagName.toLowerCase())) return false;
  return (node.children ?? []).every(isStaticInlineNode);
}
