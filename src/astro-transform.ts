import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@astrojs/compiler';
import { createMarker, decodeMarker, encodeMarker } from './marker.ts';

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'figcaption', 'dt', 'dd', 'td', 'th',
  'caption', 'legend', 'summary', 'button', 'label',
]);
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
  'ins', 'kbd', 'li', 'mark', 'p', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

interface Position {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface AstroNode {
  type: string;
  name?: string;
  value?: string;
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
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  const file = await realpath(candidate);
  if (file !== rootPath && !file.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  if (path.extname(file).toLowerCase() !== '.astro') {
    throw new Error('Only Astro source locations can be resolved.');
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
    if (!tag || !BLOCK_TAGS.has(tag) || start === undefined || end === undefined) return;
    if (offset < start || offset > end || !node.children?.length) return;
    if (node.children.every(isStaticInlineNode)) {
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
      if (context.contextMarker) {
        return resolveFrontmatterMarker(rootPath, dynamicMatch, context.contextMarker, context.renderedText);
      }
      if (context.contextHref) {
        return resolveLinkedFrontmatterMarker(rootPath, dynamicMatch, context.contextHref, context.renderedText);
      }
    }
    throw new Error('This text is not a static editable block.');
  }
  const original = source.slice(start, end);
  return encodeMarker(createMarker(
    path.relative(rootPath, file).split(path.sep).join('/'),
    start,
    end,
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
  if (!slug || !routeCollection) throw new Error('The linked content file could not be identified.');
  const collections = new Set([
    routeCollection,
    routeCollection.endsWith('s') ? routeCollection.slice(0, -1) : `${routeCollection}s`,
  ]);
  for (const collection of collections) {
    for (const extension of ['.md', '.mdx', '.mdoc']) {
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
  throw new Error('No linked content frontmatter matched this rendered text.');
}

async function resolveFrontmatterMarker(
  root: string,
  dynamic: { field: string; tag: string },
  contextToken: string,
  renderedText: string,
): Promise<string> {
  const context = decodeMarker(contextToken);
  if (context.format !== 'markdown' && context.format !== 'frontmatter') {
    throw new Error('The current content file could not be identified.');
  }
  const candidate = path.resolve(root, context.file);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  const file = await realpath(candidate);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  if (!['.md', '.mdx', '.mdoc'].includes(path.extname(file).toLowerCase())) {
    throw new Error('The current content file has no editable frontmatter.');
  }

  const source = await readFile(file, 'utf8');
  const frontmatterEnd = source.indexOf('\n---', 3);
  if (!source.startsWith('---') || frontmatterEnd < 0) {
    throw new Error('The current content file has no editable frontmatter.');
  }
  const frontmatter = source.slice(0, frontmatterEnd);
  const fieldPattern = new RegExp(`^(\\s*${dynamic.field}\\s*:\\s*)(.+?)\\s*$`, 'm');
  const match = fieldPattern.exec(frontmatter);
  if (!match) throw new Error(`The ${dynamic.field} frontmatter field was not found.`);
  const rawValue = match[2].trim();
  if (parseYamlScalar(rawValue) !== renderedText.trim()) {
    throw new Error(`The rendered ${dynamic.field} does not match the current content file.`);
  }
  const valueStart = (match.index ?? 0) + match[1].length + match[2].indexOf(rawValue);
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
  if (node.children?.length !== 1 || node.children[0].type !== 'expression') return undefined;
  const expression = (node.children[0].children ?? []).map((child) => child.value ?? '').join('').trim();
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
    if (!tag || !BLOCK_TAGS.has(tag) || start === undefined || end === undefined) return;
    if (!node.children?.length || !node.children.every(isStaticInlineNode)) return;

    const original = source.slice(start, end);
    const openingEnd = findOpeningTagEnd(source, start, end);
    if (openingEnd < 0 || !original.toLowerCase().endsWith(`</${tag}>`)) return;
    const marker = encodeMarker(createMarker(
      relative.split(path.sep).join('/'),
      start,
      end,
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

function visit(node: AstroNode, callback: (node: AstroNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function isStaticInlineNode(node: AstroNode): boolean {
  if (node.type === 'text' || node.type === 'comment') return true;
  if (node.type !== 'element' || !node.name || !INLINE_TAGS.has(node.name.toLowerCase())) return false;
  return (node.children ?? []).every(isStaticInlineNode);
}

function span(node: AstroNode): number {
  return (node.position?.end?.offset ?? 0) - (node.position?.start?.offset ?? 0);
}

function locationToOffset(source: string, location: string): number {
  const match = /^(\d+):(\d+)$/.exec(location);
  if (!match) throw new Error('The Astro source location is invalid.');
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (line < 1 || column < 1) throw new Error('The Astro source location is invalid.');
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) throw new Error('The Astro source location is invalid.');
    offset = newline + 1;
  }
  const result = offset + column - 1;
  if (result > source.length) throw new Error('The Astro source location is invalid.');
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
  return -1;
}
