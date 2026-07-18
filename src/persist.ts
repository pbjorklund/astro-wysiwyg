import { realpath, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import TurndownService from 'turndown';
import { createMarker, decodeMarker, encodeMarker } from './marker.ts';
import { isInsideProjectRoot } from './project-path.ts';

const EDITABLE_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'figcaption', 'dt', 'dd', 'td', 'th',
  'caption', 'legend', 'summary', 'button', 'label',
]);
const EDITABLE_EXTENSIONS = new Set(['.astro', '.md', '.mdx', '.mdoc']);

export interface SourceEdit {
  marker: string;
  html: string;
  tag?: string;
  text?: string;
}

export interface SourceEditResult {
  marker: string;
  file: string;
}

export interface SourceStructureEdit {
  marker: string;
  operation: 'delete' | 'insert-after';
}

export interface SourceStructureEditResult {
  marker?: string;
  file: string;
}

interface LocatedSource {
  marker: ReturnType<typeof decodeMarker>;
  filePath: string;
  source: string;
  start: number;
}

export class SourceEditError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function applySourceEdit(
  root: string,
  edit: SourceEdit,
  onBeforeWrite?: (file: string) => void | Promise<void>,
): Promise<SourceEditResult> {
  const { marker, filePath, source, start } = await locateSource(root, edit.marker);
  const tag = normalizeTag(edit.tag ?? marker.tag);
  const replacement = marker.format === 'astro'
    ? serializeAstroElement(marker.original, edit.html, marker.tag, tag)
    : marker.format === 'frontmatter'
      ? serializeFrontmatter(edit.text ?? htmlToMarkdown(edit.html), marker.original)
      : serializeMarkdown(edit.html, tag, marker.original);
  const updated = source.slice(0, start) + replacement + source.slice(start + marker.original.length);
  await onBeforeWrite?.(filePath);
  await writeFile(filePath, updated, 'utf8');

  return {
    marker: encodeMarker(createMarker(
      marker.file,
      marker.start,
      marker.start + replacement.length,
      replacement,
      marker.format,
      tag,
    )),
    file: filePath,
  };
}

export async function applySourceStructureEdit(
  root: string,
  edit: SourceStructureEdit,
): Promise<SourceStructureEditResult> {
  const { marker, filePath, source, start } = await locateSource(root, edit.marker);
  if (marker.format === 'frontmatter') {
    throw new SourceEditError('Frontmatter fields cannot be added or deleted as content blocks.', 400);
  }

  if (edit.operation === 'insert-after') {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const indentation = marker.format === 'astro' ? lineIndentation(source, start) : '';
    const separator = marker.format === 'astro' ? `${newline}${indentation}` : `${newline}${newline}`;
    const inserted = marker.format === 'astro' ? '<p>New paragraph</p>' : 'New paragraph';
    const insertion = start + marker.original.length;
    const updated = source.slice(0, insertion) + separator + inserted + source.slice(insertion);
    await writeFile(filePath, updated, 'utf8');
    const markerStart = marker.start + marker.original.length + separator.length;
    return {
      file: filePath,
      marker: encodeMarker(createMarker(
        marker.file,
        markerStart,
        markerStart + inserted.length,
        inserted,
        marker.format,
        'p',
      )),
    };
  }

  const [deletionStart, deletionEnd] = marker.format === 'astro'
    ? astroDeletionRange(source, start, marker.original.length)
    : markdownDeletionRange(source, start, marker.original.length);
  await writeFile(filePath, source.slice(0, deletionStart) + source.slice(deletionEnd), 'utf8');
  return { file: filePath };
}

async function locateSource(root: string, token: string): Promise<LocatedSource> {
  const marker = decodeMarker(token);
  const rootPath = await realpath(root);
  const candidate = path.resolve(rootPath, marker.file);
  assertInsideRoot(rootPath, candidate);
  if (!EDITABLE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
    throw new SourceEditError('This source file type cannot be edited.', 400);
  }

  let filePath: string;
  try {
    filePath = await realpath(candidate);
  } catch {
    throw new SourceEditError('The source file no longer exists. Reload the page and try again.', 404);
  }
  assertInsideRoot(rootPath, filePath);

  const source = await readFile(filePath, 'utf8');
  const start = locateOriginal(source, marker.original, marker.start, marker.end);
  return { marker, filePath, source, start };
}

function lineIndentation(source: string, start: number): string {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const prefix = source.slice(lineStart, start);
  return prefix.trim() ? '' : prefix;
}

function markdownDeletionRange(source: string, start: number, length: number): [number, number] {
  const end = start + length;
  const followingSeparator = /^(?:\r?\n){2}/.exec(source.slice(end))?.[0];
  if (followingSeparator) return [start, end + followingSeparator.length];
  const precedingSeparator = /(?:\r?\n){2}$/.exec(source.slice(0, start))?.[0];
  if (precedingSeparator) return [start - precedingSeparator.length, end];
  return [start, end];
}

function astroDeletionRange(source: string, start: number, length: number): [number, number] {
  const end = start + length;
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = source.indexOf('\n', end);
  const lineEnd = nextNewline < 0 ? source.length : nextNewline;
  if (!source.slice(lineStart, start).trim() && !source.slice(end, lineEnd).trim()) {
    return [lineStart, nextNewline < 0 ? lineEnd : lineEnd + 1];
  }
  return [start, end];
}

function assertInsideRoot(root: string, candidate: string): void {
  if (!isInsideProjectRoot(root, candidate)) {
    throw new SourceEditError('The requested file is outside the Astro project root.', 403);
  }
}

function locateOriginal(source: string, original: string, start: number, end: number): number {
  if (source.slice(start, end) === original) return start;

  const first = source.indexOf(original);
  if (first >= 0 && source.indexOf(original, first + Math.max(original.length, 1)) === -1) return first;

  throw new SourceEditError(
    'The source changed after this page loaded. Reload the page before editing this block.',
    409,
  );
}

function normalizeTag(tag: string): string {
  const normalized = tag.toLowerCase();
  if (!EDITABLE_TAGS.has(normalized)) {
    throw new SourceEditError('That block format is not supported.', 400);
  }
  return normalized;
}

function serializeFrontmatter(value: string, original: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (original.startsWith("'") && original.endsWith("'")) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  if (original.startsWith('"') && original.endsWith('"')) return JSON.stringify(text);
  return /^[\p{L}\p{N}][^:#\[\]{},&*!|>'"%@`]*$/u.test(text) ? text : JSON.stringify(text);
}

function htmlToMarkdown(html: string): string {
  return new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    headingStyle: 'atx',
    strongDelimiter: '**',
  }).turndown(html);
}

function serializeMarkdown(html: string, tag: string, original: string): string {
  const content = htmlToMarkdown(html).trim();
  if (tag === 'ul' || tag === 'ol') {
    return htmlToMarkdown(`<${tag}>${html}</${tag}>`)
      .trim()
      .replace(/^(\s*(?:-|\d+\.))\s{2,}/gm, '$1 ');
  }
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${content}`;
  if (tag === 'li') {
    const marker = /^(\s*(?:[-+*]|\d+[.)])\s+)/.exec(original)?.[1] ?? '- ';
    const continuation = ' '.repeat(marker.length);
    return marker + content.replace(/\n/g, `\n${continuation}`);
  }
  return content;
}

function serializeAstroElement(original: string, html: string, oldTag: string, newTag: string): string {
  const openEnd = findOpeningTagEnd(original);
  const closeStart = original.lastIndexOf('</');
  if (openEnd < 0 || closeStart <= openEnd) {
    throw new SourceEditError('The Astro source block is no longer editable.', 409);
  }

  let opening = original.slice(0, openEnd + 1);
  let closing = original.slice(closeStart);
  if (newTag !== oldTag) {
    opening = opening.replace(new RegExp(`^<${escapeRegExp(oldTag)}(?=[\\s>])`, 'i'), `<${newTag}`);
    closing = closing.replace(new RegExp(`^</${escapeRegExp(oldTag)}\\s*>$`, 'i'), `</${newTag}>`);
  }
  return `${opening}${html}${closing}`;
}

function findOpeningTagEnd(value: string): number {
  let quote = '';
  let braces = 0;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      braces += 1;
    } else if (character === '}') {
      braces = Math.max(0, braces - 1);
    } else if (character === '>' && braces === 0) {
      return index;
    }
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
