import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { decodeMarker } from './marker.ts';
import { isInsideProjectRoot } from './project-path.ts';
import { mutateTextFile } from './source-file.ts';

export type FrontmatterFieldType = 'boolean' | 'date' | 'list' | 'number' | 'string';

export interface FrontmatterField {
  name: string;
  type: FrontmatterFieldType;
  value: string | boolean;
  original: string;
}

export interface FrontmatterChange {
  value: string | boolean;
  original: string;
}

export class FrontmatterEditError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'FrontmatterEditError';
    this.status = status;
  }
}

interface ParsedField extends FrontmatterField {
  start: number;
  end: number;
}

export async function readFrontmatterFields(
  root: string,
  contextMarker: string,
  writableRoot = root,
): Promise<FrontmatterField[]> {
  const { source } = await readContextSource(root, contextMarker, writableRoot);
  return parseFrontmatter(source).map(({ name, type, value, original }) => ({ name, type, value, original }));
}

export async function updateFrontmatterFields(
  root: string,
  contextMarker: string,
  changes: Record<string, FrontmatterChange>,
  writableRoot = root,
): Promise<void> {
  const file = await resolveContextFile(root, contextMarker, writableRoot);
  await mutateTextFile(file, (source) => {
    const fields = parseFrontmatter(source);
    const fieldsByName = new Map(fields.map((field) => [field.name, field]));
    for (const [name, change] of Object.entries(changes)) {
      const field = fieldsByName.get(name);
      if (!field) throw new Error(`The ${name} frontmatter field does not exist.`);
      if (field.original !== change.original) {
        throw new FrontmatterEditError(
          `The ${name} frontmatter field changed on disk. Close and reopen the frontmatter editor before saving again.`,
          409,
        );
      }
    }

    let updated = source;
    const replacements = Object.entries(changes)
      .map(([name, change]) => ({ field: fieldsByName.get(name)!, value: change.value }))
      .sort((left, right) => right.field.start - left.field.start);
    for (const { field, value } of replacements) {
      const replacement = serializeValue(field, value);
      updated = updated.slice(0, field.start) + replacement + updated.slice(field.end);
    }
    return { source: updated, result: undefined };
  });
}

async function readContextSource(
  root: string,
  token: string,
  writableRoot: string,
): Promise<{ file: string; source: string }> {
  const file = await resolveContextFile(root, token, writableRoot);
  return { file, source: await readFile(file, 'utf8') };
}

async function resolveContextFile(root: string, token: string, writableRoot: string): Promise<string> {
  const marker = decodeMarker(token);
  const [rootPath, writableRootPath] = await Promise.all([realpath(root), realpath(writableRoot)]);
  const candidate = path.resolve(rootPath, marker.file);
  if (!isInsideProjectRoot(rootPath, candidate)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  if (!isInsideProjectRoot(writableRootPath, candidate)) {
    throw new FrontmatterEditError('Frontmatter edits are limited to the configured Astro source directory.', 403);
  }
  const file = await realpath(candidate);
  if (!isInsideProjectRoot(rootPath, file)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  if (!isInsideProjectRoot(writableRootPath, file)) {
    throw new FrontmatterEditError('Frontmatter edits are limited to the configured Astro source directory.', 403);
  }
  if (!['.md', '.mdx'].includes(path.extname(file).toLowerCase())) {
    throw new Error('This source file has no editable frontmatter.');
  }
  return file;
}

function parseFrontmatter(source: string): ParsedField[] {
  const end = source.indexOf('\n---', 3);
  if (!source.startsWith('---') || end < 0) throw new Error('The content file has no frontmatter.');
  const frontmatter = source.slice(0, end);
  const fields: ParsedField[] = [];
  const pattern = /^([A-Za-z_][\w-]*):[ \t]*(.+?)[ \t]*$/gm;
  for (const match of frontmatter.matchAll(pattern)) {
    const original = match[2].trim();
    if (!original || original === '|' || original === '>') continue;
    const start = match.index + match[0].indexOf(match[2]) + match[2].indexOf(original);
    const parsed = parseValue(original);
    if (!parsed) continue;
    fields.push({
      name: match[1],
      type: parsed.type,
      value: parsed.value,
      start,
      end: start + original.length,
      original,
    });
  }
  return fields;
}

function parseValue(original: string): Pick<FrontmatterField, 'type' | 'value'> | undefined {
  if (original === 'true' || original === 'false') {
    return { type: 'boolean', value: original === 'true' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(original)) return { type: 'date', value: original };
  if (/^-?\d+(?:\.\d+)?$/.test(original)) return { type: 'number', value: original };
  if (original.startsWith('[') && original.endsWith(']')) {
    try {
      const value = JSON.parse(original) as unknown;
      if (Array.isArray(value) && value.every((item) => (
        typeof item === 'string'
        && item.length > 0
        && item.trim() === item
        && !item.includes(',')
      ))) {
        return { type: 'list', value: value.join(', ') };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (original.startsWith('"') && original.endsWith('"')) {
    try {
      return { type: 'string', value: JSON.parse(original) as string };
    } catch {
      return { type: 'string', value: original.slice(1, -1) };
    }
  }
  if (original.startsWith("'") && original.endsWith("'")) {
    return { type: 'string', value: original.slice(1, -1).replace(/''/g, "'") };
  }
  return { type: 'string', value: original };
}

function serializeValue(field: ParsedField, value: string | boolean): string {
  if (field.type === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
  const text = String(value).trim();
  if (field.type === 'list') {
    return JSON.stringify(text.split(',').map((item) => item.trim()).filter(Boolean));
  }
  if (field.type === 'number') {
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
      throw new FrontmatterEditError(`${field.name} must be a number.`, 400);
    }
    return text;
  }
  if (field.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new FrontmatterEditError(`${field.name} must use YYYY-MM-DD.`, 400);
    }
    return text;
  }
  if (field.original.startsWith("'") && field.original.endsWith("'")) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  if (field.original.startsWith('"') && field.original.endsWith('"')) return JSON.stringify(text);
  return /^[\p{L}\p{N}][^:#\[\]{},&*!|>'"%@`]*$/u.test(text) ? text : JSON.stringify(text);
}
