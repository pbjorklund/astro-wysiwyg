import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@astrojs/compiler';
import { EDITABLE_BLOCK_TAGS } from './editable-tags.ts';
import { createMarker, decodeMarker, encodeMarker } from './marker.ts';
import { isInsideProjectRoot } from './project-path.ts';
import { inspectSourceVideoFigure } from './video-markup.ts';
import { inspectSourceIframe } from './iframe-markup.ts';
import { SourceEditError } from './persist.ts';

const BLOCK_TAGS = new Set(EDITABLE_BLOCK_TAGS);
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
  'img', 'ins', 'kbd', 'li', 'mark', 'p', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

interface Position {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface AstroAttribute {
  kind: string;
  name: string;
  value?: string;
}

interface AstroNode {
  type: string;
  name?: string;
  value?: string;
  attributes?: AstroAttribute[];
  children?: AstroNode[];
  position?: Position;
}

export interface AstroSourceContext {
  contextMarker?: string;
  contextHref?: string;
  renderedText?: string;
}

interface Insertion {
  offset: number;
  value: string;
}

export async function resolveAstroSourceMarker(
  root: string,
  sourceFile: string,
  sourceLocation: string,
  context: AstroSourceContext = {},
): Promise<string> {
  const rootPath = await realpath(root);
  const candidate = path.isAbsolute(sourceFile) ? path.resolve(sourceFile) : path.resolve(rootPath, sourceFile);
  if (!isInsideProjectRoot(rootPath, candidate)) {
    throw new SourceEditError('The requested file is outside the Astro project root.', 403);
  }
  const file = await realpath(candidate);
  if (!isInsideProjectRoot(rootPath, file)) {
    throw new SourceEditError('The requested file is outside the Astro project root.', 403);
  }
  if (path.extname(file).toLowerCase() !== '.astro') {
    throw new SourceEditError('Only Astro source locations can be resolved.', 400);
  }

  const source = await readFile(file, 'utf8');
  const offset = locationToOffset(source, sourceLocation);
  const result = await parse(source, { position: true });
  const matches: AstroNode[] = [];
  let dynamicMatch: { field: string; tag: string } | undefined;
  visit(result.ast as AstroNode, (node) => {
    const tag = node.name?.toLowerCase();
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (!tag || start === undefined || end === undefined) return;
    if (offset < start || offset > end) return;
    const sourceEnd = nodeSourceEnd(source, tag, end);
    const original = source.slice(start, sourceEnd);
    if ((tag === 'figure' && inspectSourceVideoFigure(original))
      || (tag === 'iframe' && inspectSourceIframe(original))
      || (tag === 'hr' && isStaticDivider(original))) {
      matches.push(node);
      return;
    }
    if (!node.children?.length || !BLOCK_TAGS.has(tag)) return;
    if (node.children.every(isStaticInlineNode) && node.children.every((child) => hasResolvableImageSources(child, source))) {
      matches.push(node);
      return;
    }
    const field = dataField(node);
    if (field) dynamicMatch = { field, tag };
  });
  matches.sort((left, right) => span(left) - span(right));
  const node = matches[0];
  const tag = node?.name?.toLowerCase();
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  if (!node || !tag || start === undefined || end === undefined) {
    if (dynamicMatch && context.renderedText !== undefined) {
      if (context.contextHref) {
        return resolveLinkedFrontmatterMarker(rootPath, dynamicMatch, context.contextHref, context.renderedText);
      }
      if (context.contextMarker) {
        return resolveFrontmatterMarker(rootPath, dynamicMatch, context.contextMarker, context.renderedText);
      }
    }
    throw new SourceEditError('This text is not a static editable block.', 400);
  }
  const sourceEnd = nodeSourceEnd(source, tag, end);
  const original = source.slice(start, sourceEnd);
  return encodeMarker(createMarker(
    path.relative(rootPath, file).split(path.sep).join('/'),
    start,
    sourceEnd,
    original,
    'astro',
    tag,
  ));
}

async function resolveLinkedFrontmatterMarker(
  root: string,
  dynamic: { field: string; tag: string },
  href: string,
  renderedText: string,
): Promise<string> {
  const pathname = new URL(href, 'http://astro.local').pathname;
  const segments = pathname.split('/').filter(Boolean);
  const slug = segments.at(-1);
  const routeCollection = segments.at(-2);
  if (!slug || !routeCollection) throw new SourceEditError('The linked content file could not be identified.', 400);
  const collections = new Set([
    routeCollection,
    routeCollection.endsWith('s') ? routeCollection.slice(0, -1) : `${routeCollection}s`,
  ]);
  for (const collection of collections) {
    for (const extension of ['.md', '.mdx']) {
      for (const relative of [
        path.join('src', 'content', collection, slug, `index${extension}`),
        path.join('src', 'content', collection, `${slug}${extension}`),
      ]) {
        const token = encodeMarker(createMarker(relative, 0, 0, '', 'markdown', 'p'));
        try {
          return await resolveFrontmatterMarker(root, dynamic, token, renderedText);
        } catch {
          // Try the next conventional Astro content path.
        }
      }
    }
  }
  throw new SourceEditError('No linked content frontmatter matched this rendered text.', 400);
}

async function resolveFrontmatterMarker(
  root: string,
  dynamic: { field: string; tag: string },
  contextToken: string,
  renderedText: string,
): Promise<string> {
  const context = decodeMarker(contextToken);
  if (context.format !== 'markdown' && context.format !== 'frontmatter') {
    throw new SourceEditError('The current content file could not be identified.', 400);
  }
  const candidate = path.resolve(root, context.file);
  if (!isInsideProjectRoot(root, candidate)) {
    throw new SourceEditError('The requested file is outside the Astro project root.', 403);
  }
  const file = await realpath(candidate);
  if (!isInsideProjectRoot(root, file)) {
    throw new SourceEditError('The requested file is outside the Astro project root.', 403);
  }
  if (!['.md', '.mdx'].includes(path.extname(file).toLowerCase())) {
    throw new SourceEditError('The current content file has no editable frontmatter.', 400);
  }

  const source = await readFile(file, 'utf8');
  const frontmatterEnd = source.indexOf('\n---', 3);
  if (!source.startsWith('---') || frontmatterEnd < 0) {
    throw new SourceEditError('The current content file has no editable frontmatter.', 400);
  }
  const frontmatter = source.slice(0, frontmatterEnd);
  const fieldPattern = new RegExp(`^(\\s*${dynamic.field}\\s*:\\s*)(.+?)\\s*$`, 'm');
  const match = fieldPattern.exec(frontmatter);
  if (!match) throw new SourceEditError(`The ${dynamic.field} frontmatter field was not found.`, 400);
  const rawValue = match[2].trim();
  if (parseYamlScalar(rawValue) !== renderedText.trim()) {
    throw new SourceEditError(`The rendered ${dynamic.field} does not match the current content file.`, 400);
  }
  const valueStart = match.index + match[1].length + match[2].indexOf(rawValue);
  return encodeMarker(createMarker(
    context.file,
    valueStart,
    valueStart + rawValue.length,
    rawValue,
    'frontmatter',
    dynamic.tag,
  ));
}

function dataField(node: AstroNode): string | undefined {
  if (node.children!.length !== 1 || node.children![0].type !== 'expression') return undefined;
  const expression = node.children![0].children!.map((child) => child.value).join('').trim();
  return /(?:^|\.)(?:data|frontmatter)\.([A-Za-z_$][\w$]*)$/.exec(expression)?.[1];
}

function parseYamlScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export async function annotateAstroSource(
  source: string,
  id: string,
  root: string,
): Promise<string | null> {
  const cleanId = id.split('?', 1)[0];
  const relative = path.relative(root, cleanId);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const result = await parse(source, { position: true });
  const insertions: Insertion[] = [];
  visit(result.ast as AstroNode, (node) => {
    const tag = node.name?.toLowerCase();
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (!tag || start === undefined || end === undefined) return;
    const sourceEnd = nodeSourceEnd(source, tag, end);
    const original = source.slice(start, sourceEnd);
    const openingEnd = findOpeningTagEnd(source, start, sourceEnd);
    const mediaAttribute = tag === 'figure' && inspectSourceVideoFigure(original)
      ? 'data-astro-wysiwyg-video'
      : tag === 'iframe' && inspectSourceIframe(original)
        ? 'data-astro-wysiwyg-iframe'
        : undefined;
    if (mediaAttribute) {
      /* c8 ignore next -- positioned compiler elements always have a complete opening tag. */
      if (openingEnd < 0) return;
      const marker = encodeMarker(createMarker(
        relative.split(path.sep).join('/'), start, sourceEnd, original, 'astro', tag,
      ));
      insertions.push({
        offset: openingEnd,
        value: ` data-astro-wysiwyg="${marker}" ${mediaAttribute}`,
      });
      return;
    }
    if (tag === 'hr' && isStaticDivider(original)) {
      /* c8 ignore next -- positioned compiler elements always have a complete opening tag. */
      if (openingEnd < 0) return;
      const marker = encodeMarker(createMarker(
        relative.split(path.sep).join('/'), start, sourceEnd, original, 'astro', tag,
      ));
      const offset = source[openingEnd - 1] === '/' ? openingEnd - 1 : openingEnd;
      insertions.push({ offset, value: ` data-astro-wysiwyg="${marker}"` });
      return;
    }
    if (!BLOCK_TAGS.has(tag)
      || !node.children?.length
      || !node.children.every(isStaticInlineNode)
      || !node.children.every((child) => hasResolvableImageSources(child, source))) return;

    /* c8 ignore next -- positioned static compiler elements always have matching opening and closing tags. */
    if (openingEnd < 0 || !original.toLowerCase().endsWith(`</${tag}>`)) return;
    const marker = encodeMarker(createMarker(
      relative.split(path.sep).join('/'),
      start,
      sourceEnd,
      original,
      'astro',
      tag,
    ));
    insertions.push({ offset: openingEnd, value: ` data-astro-wysiwyg="${marker}"` });
  });

  if (insertions.length === 0) return null;
  let transformed = source;
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    transformed = transformed.slice(0, insertion.offset) + insertion.value + transformed.slice(insertion.offset);
  }
  return transformed;
}

function nodeSourceEnd(source: string, tag: string, end: number): number {
  return tag === 'hr' && source[end] === '>' ? end + 1 : end;
}

function isStaticDivider(source: string): boolean {
  return /^<hr\s*\/?>$/i.test(source.trim());
}

function visit(node: AstroNode, callback: (node: AstroNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function isStaticInlineNode(node: AstroNode): boolean {
  if (node.type === 'text' || node.type === 'comment') return true;
  if (node.type !== 'element' || !node.name || !INLINE_TAGS.has(node.name.toLowerCase())) return false;
  const attributesSafe = node.name.toLowerCase() === 'img'
    ? node.attributes!.every(isSafeImageAttribute)
    : node.attributes!.every(isStaticHtmlAttribute);
  if (!attributesSafe) return false;
  return node.children!.every(isStaticInlineNode);
}

function hasResolvableImageSources(node: AstroNode, source: string): boolean {
  if (node.type !== 'element') return true;
  if (node.name?.toLowerCase() === 'img') {
    const expression = node.attributes?.find((attribute) => (
      attribute.name === 'src' && attribute.kind === 'expression'
    ))?.value;
    if (expression) {
      const importName = /^([A-Za-z_$][\w$]*)\.src$/.exec(expression)?.[1];
      if (!importName || !hasDefaultImageImport(source, importName)) return false;
    }
  }
  return node.children!.every((child) => hasResolvableImageSources(child, source));
}

function hasDefaultImageImport(source: string, importName: string): boolean {
  const escapedName = importName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)\\s*import\\s+${escapedName}\\s+from\\s+["']\\.{1,2}\\/[A-Za-z0-9._/-]+\\.(?:gif|jpe?g|png|webp)["']\\s*;?`,
  );
  const importMatch = pattern.exec(source);
  if (!importMatch) return false;
  const sourceWithoutImport = source.slice(0, importMatch.index)
    + source.slice(importMatch.index + importMatch[0].length);
  const executableSource = sourceWithoutImport.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    '',
  );
  return [...executableSource.matchAll(new RegExp(`\\b${escapedName}\\b`, 'g'))].length === 1;
}

function isSafeImageAttribute(attribute: AstroAttribute): boolean {
  if (attribute.name === 'src' && attribute.kind === 'expression') {
    return /^[A-Za-z_$][\w$]*\.src$/.test(attribute.value!);
  }
  return isStaticHtmlAttribute(attribute);
}

function isStaticHtmlAttribute(attribute: AstroAttribute): boolean {
  return (attribute.kind === 'quoted' || attribute.kind === 'empty')
    && !attribute.name.includes(':');
}

function span(node: AstroNode): number {
  return node.position!.end!.offset! - node.position!.start!.offset!;
}

function locationToOffset(source: string, location: string): number {
  const match = /^(\d+):(\d+)$/.exec(location);
  if (!match) throw new SourceEditError('The Astro source location is invalid.', 400);
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (line < 1 || column < 1) throw new SourceEditError('The Astro source location is invalid.', 400);
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) throw new SourceEditError('The Astro source location is invalid.', 400);
    offset = newline + 1;
  }
  const result = offset + column - 1;
  if (result > source.length) throw new SourceEditError('The Astro source location is invalid.', 400);
  return result;
}

function findOpeningTagEnd(source: string, start: number, end: number): number {
  let quote = '';
  let braces = 0;
  for (let index = start + 1; index < end; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') braces += 1;
    else if (character === '}') braces = Math.max(0, braces - 1);
    else if (character === '>' && braces === 0) return index;
  }
  /* c8 ignore next -- Astro's compiler reports positions only for elements with a complete opening tag. */
  return -1;
}
