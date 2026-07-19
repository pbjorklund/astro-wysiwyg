import { realpath } from 'node:fs/promises';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';
import TurndownService from 'turndown';
import { EDITABLE_BLOCK_TAGS } from './editable-tags.ts';
import { createMarker, decodeMarker, encodeMarker } from './marker.ts';
import { isInsideProjectRoot } from './project-path.ts';
import { mutateTextFile } from './source-file.ts';

const EDITABLE_TAGS = new Set(EDITABLE_BLOCK_TAGS);
const EDITABLE_EXTENSIONS = new Set(['.astro', '.md', '.mdx']);
const SAFE_INLINE_TAGS = [
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
  'ins', 'kbd', 'li', 'mark', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
];
const SAFE_INLINE_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['aria-*', 'class', 'data-*', 'dir', 'id', 'lang', 'role', 'title'],
  a: ['download', 'href', 'hreflang', 'name', 'referrerpolicy', 'rel', 'target'],
  data: ['value'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  q: ['cite'],
  time: ['datetime'],
};

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

interface SourceTarget {
  marker: ReturnType<typeof decodeMarker>;
  filePath: string;
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
  writableRoot = root,
): Promise<SourceEditResult> {
  const { marker, filePath } = await resolveSourceTarget(root, edit.marker, writableRoot);
  const tag = normalizeTag(edit.tag ?? marker.tag);
  const safeHtml = sanitizeEditedHtml(edit.html);

  return mutateTextFile(filePath, async (source) => {
    const start = locateOriginal(source, marker.original, marker.start, marker.end);
    const replacement = marker.format === 'astro'
      ? serializeAstroElement(marker.original, escapeAstroTextExpressions(safeHtml), marker.tag, tag)
      : marker.format === 'frontmatter'
        ? serializeFrontmatter(edit.text ?? htmlToMarkdown(safeHtml), marker.original)
        : serializeMarkdownEdit(marker.file, safeHtml, tag, marker.original);
    const updated = source.slice(0, start) + replacement + source.slice(start + marker.original.length);
    await onBeforeWrite?.(filePath);

    return {
      source: updated,
      result: {
        marker: encodeMarker(createMarker(
          marker.file,
          marker.start,
          marker.start + replacement.length,
          replacement,
          marker.format,
          tag,
        )),
        file: filePath,
      },
    };
  });
}

export async function applySourceStructureEdit(
  root: string,
  edit: SourceStructureEdit,
  writableRoot = root,
): Promise<SourceStructureEditResult> {
  const { marker, filePath } = await resolveSourceTarget(root, edit.marker, writableRoot);

  return mutateTextFile<SourceStructureEditResult>(filePath, (source) => {
    const start = locateOriginal(source, marker.original, marker.start, marker.end);
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
      const markerStart = marker.start + marker.original.length + separator.length;
      return {
        source: updated,
        result: {
          file: filePath,
          marker: encodeMarker(createMarker(
            marker.file,
            markerStart,
            markerStart + inserted.length,
            inserted,
            marker.format,
            'p',
          )),
        },
      };
    }

    const [deletionStart, deletionEnd] = marker.format === 'astro'
      ? astroDeletionRange(source, start, marker.original.length)
      : markdownDeletionRange(source, start, marker.original.length);
    return {
      source: source.slice(0, deletionStart) + source.slice(deletionEnd),
      result: { file: filePath },
    };
  });
}

async function resolveSourceTarget(root: string, token: string, writableRoot: string): Promise<SourceTarget> {
  const marker = decodeMarker(token);
  const [rootPath, writableRootPath] = await Promise.all([realpath(root), realpath(writableRoot)]);
  const candidate = path.resolve(rootPath, marker.file);
  assertInsideRoot(rootPath, candidate);
  assertInsideWritableRoot(writableRootPath, candidate);
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
  assertInsideWritableRoot(writableRootPath, filePath);
  return { marker, filePath };
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

function assertInsideWritableRoot(root: string, candidate: string): void {
  if (!isInsideProjectRoot(root, candidate)) {
    throw new SourceEditError('Source edits are limited to the configured Astro source directory.', 403);
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

function sanitizeEditedHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedAttributes: SAFE_INLINE_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedTags: SAFE_INLINE_TAGS,
  });
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

function serializeMarkdownEdit(file: string, html: string, tag: string, original: string): string {
  const markdown = serializeMarkdown(html, tag, original);
  return path.extname(file).toLowerCase() === '.mdx' ? escapeMdxTextExpressions(markdown) : markdown;
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

function escapeAstroTextExpressions(html: string): string {
  let result = '';
  let inTag = false;
  let quote = '';
  for (let index = 0; index < html.length; index += 1) {
    const character = html[index];
    if (inTag) {
      result += character;
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        inTag = false;
      }
    } else if (character === '<') {
      inTag = true;
      result += character;
    } else if (character === '{') {
      result += '&#123;';
    } else if (character === '}') {
      result += '&#125;';
    } else {
      result += character;
    }
  }
  return result;
}

function escapeMdxTextExpressions(markdown: string): string {
  let fence: { character: string; length: number } | undefined;
  return markdown.split(/(\r?\n)/).map((line) => {
    if (/^\r?\n$/.test(line)) return line;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.character && marker.length >= fence.length) fence = undefined;
      return line;
    }
    if (marker) {
      fence = { character: marker[0], length: marker.length };
      return line;
    }
    return escapeMdxInlineTextExpressions(line);
  }).join('');
}

function escapeMdxInlineTextExpressions(line: string): string {
  let result = '';
  for (let index = 0; index < line.length;) {
    if (line[index] === '`') {
      let length = 1;
      while (line[index + length] === '`') length += 1;
      const marker = '`'.repeat(length);
      const end = line.indexOf(marker, index + length);
      if (end >= 0) {
        result += line.slice(index, end + length);
        index = end + length;
        continue;
      }
    }
    result += line[index] === '{' ? '&#123;' : line[index] === '}' ? '&#125;' : line[index];
    index += 1;
  }
  return result;
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
