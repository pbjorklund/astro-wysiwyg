import path from 'node:path';
import { MARKDOWN_EDITABLE_BLOCK_TAGS } from './editable-tags.ts';
import { createMarker, encodeMarker } from './marker.ts';
import { addVideoMarkerAttributes, inspectSourceVideoFigure } from './video-markup.ts';
import { addIframeMarkerAttributes, inspectSourceIframe } from './iframe-markup.ts';

const BLOCK_TAGS = new Set(MARKDOWN_EDITABLE_BLOCK_TAGS);
const TURNDOWN_INLINE_TAGS = new Set([
  'a', 'b', 'br', 'code', 'em', 'i', 'img', 'li', 'p', 'strong',
]);

interface HastPosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface HastNode {
  type: string;
  tagName?: string;
  name?: string;
  value?: string;
  attributes?: Array<{ type: string; name: string; value: string }>;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: HastPosition;
}

interface MdastNode {
  type: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  name?: string;
  value?: string;
  attributes?: Array<{ type: string; name: string; value: string }>;
  children?: MdastNode[];
  position?: HastPosition;
}

interface StaticContentMarker {
  marker: string;
  tag: 'blockquote' | 'hr' | 'pre';
}

interface VFileLike {
  path?: string;
  value: unknown;
  data?: { astroWysiwygStaticMarkers?: StaticContentMarker[] };
}

export interface RehypeEditableOptions {
  root: string;
}

export function remarkEditableMedia(options: RehypeEditableOptions) {
  return function transform(tree: MdastNode, file: VFileLike): void {
    if (!file.path) return;
    const relative = path.relative(options.root, file.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    const source = String(file.value);
    visitMdast(tree, (node) => {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start === undefined || end === undefined) return;
      const original = source.slice(start, end);
      const staticTag = node.type === 'blockquote'
        ? 'blockquote'
        : node.type === 'code'
          ? 'pre'
          : node.type === 'thematicBreak'
            ? 'hr'
            : undefined;
      if (staticTag && isStaticMarkdownContentBlock(staticTag, original)) {
        const marker = encodeMarker(createMarker(
          relative.split(path.sep).join('/'), start, end, original, 'markdown', staticTag,
        ));
        node.data ??= {};
        node.data.hProperties = { ...(node.data.hProperties ?? {}), 'data-astro-wysiwyg': marker };
        file.data ??= {};
        file.data.astroWysiwygStaticMarkers ??= [];
        file.data.astroWysiwygStaticMarkers.push({ marker, tag: staticTag });
        return;
      }
      const media = inspectSourceVideoFigure(original)
        ? { tag: 'figure', attribute: 'data-astro-wysiwyg-video', add: addVideoMarkerAttributes }
        : inspectSourceIframe(original)
          ? { tag: 'iframe', attribute: 'data-astro-wysiwyg-iframe', add: addIframeMarkerAttributes }
          : undefined;
      if (!media) return;
      const marker = encodeMarker(createMarker(
        relative.split(path.sep).join('/'), start, end, original, 'markdown', media.tag,
      ));
      if (node.type === 'html') {
        const marked = media.add(original, marker);
        /* c8 ignore next -- Inspection and marker injection parse the same unchanged source. */
        if (marked) node.value = marked;
      } else if (node.type === 'mdxJsxFlowElement' && node.name?.toLowerCase() === media.tag) {
        node.attributes ??= [];
        node.attributes.push(
          { type: 'mdxJsxAttribute', name: 'data-astro-wysiwyg', value: marker },
          { type: 'mdxJsxAttribute', name: media.attribute, value: '' },
        );
      }
    });
  };
}

export function rehypeEditableBlocks(options: RehypeEditableOptions) {
  return function transform(tree: HastNode, file: VFileLike): void {
    if (!file.path) return;
    const relative = path.relative(options.root, file.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    const source = String(file.value);
    const staticMarkers = [...(file.data?.astroWysiwygStaticMarkers ?? [])];

    visit(tree, (node) => {
      const tag = (node.tagName ?? node.name)?.toLowerCase();
      const staticMarkerIndex = staticMarkers.findIndex((candidate) => candidate.tag === tag);
      if (staticMarkerIndex >= 0) {
        const [candidate] = staticMarkers.splice(staticMarkerIndex, 1);
        node.properties ??= {};
        node.properties['data-astro-wysiwyg'] = candidate.marker;
        return true;
      }
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start === undefined || end === undefined) return false;
      const original = source.slice(start, end);
      const relativeFile = relative.split(path.sep).join('/');
      const media = inspectSourceVideoFigure(original)
        ? { tag: 'figure', attribute: 'data-astro-wysiwyg-video', add: addVideoMarkerAttributes }
        : inspectSourceIframe(original)
          ? { tag: 'iframe', attribute: 'data-astro-wysiwyg-iframe', add: addIframeMarkerAttributes }
          : undefined;
      if ((tag === media?.tag || node.type === 'raw') && media) {
        const marker = encodeMarker(createMarker(
          relativeFile, start, end, original, 'markdown', media.tag,
        ));
        if (node.type === 'mdxJsxFlowElement') {
          node.attributes ??= [];
          node.attributes.push(
            { type: 'mdxJsxAttribute', name: 'data-astro-wysiwyg', value: marker },
            { type: 'mdxJsxAttribute', name: media.attribute, value: '' },
          );
        } else if (tag === media.tag) {
          node.properties ??= {};
          node.properties['data-astro-wysiwyg'] = marker;
          node.properties[media.attribute] = '';
        } else {
          const marked = media.add(original, marker);
          /* c8 ignore next -- Inspection and marker injection parse the same unchanged source. */
          if (!marked) return false;
          node.value = marked;
        }
        return true;
      }
      if (!tag || !BLOCK_TAGS.has(tag)) return false;
      if (!(node.children ?? []).every((child) => isRoundTripSafeInlineNode(child, source))) return false;
      if (!original) return false;

      node.properties ??= {};
      node.properties['data-astro-wysiwyg'] = encodeMarker(createMarker(
        relativeFile,
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

function isStaticMarkdownContentBlock(tag: string, source: string): boolean {
  const value = source.trim();
  if (tag === 'hr') return /^(?:\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)$/.test(value);
  if (tag === 'pre') return /^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*\n(?:`{3,}|~{3,})$/.test(value);
  return value.split(/\r?\n/).every((line) => /^ {0,3}>/.test(line))
    && !/[{}]|<\/?[A-Z][A-Za-z0-9.]*/.test(value);
}

function visitMdast(node: MdastNode, callback: (node: MdastNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) visitMdast(child, callback);
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
  if (tag === 'img') return isRoundTripSafeImage(node, source);
  return (node.children ?? []).every((child) => isRoundTripSafeInlineNode(child, source));
}

function isRoundTripSafeImage(node: HastNode, source: string): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return false;
  const original = source.slice(start, end);
  return original.startsWith('![') && /^!\[[\s\S]*\]\([^\r\n]+\)$/.test(original);
}

function isRoundTripSafeLink(node: HastNode, source: string): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return false;
  const original = source.slice(start, end);
  return !original.startsWith('[') || original.includes('](');
}
