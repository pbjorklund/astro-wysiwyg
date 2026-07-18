import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeMarker } from './marker.ts';
import { isInsideProjectRoot } from './project-path.ts';

export type FrontmatterFieldType = 'boolean' | 'date' | 'list' | 'number' | 'string';

export interface FrontmatterField {
  name: string;
  type: FrontmatterFieldType;
  value: string | boolean;
}

interface ParsedField extends FrontmatterField {
  start: number;
  end: number;
  original: string;
}

export async function readFrontmatterFields(root: string, contextMarker: string): Promise<FrontmatterField[]> {
  const { source } = await readContextSource(root, contextMarker);
  return parseFrontmatter(source).map(({ name, type, value }) => ({ name, type, value }));
}

export async function updateFrontmatterFields(
  root: string,
  contextMarker: string,
  values: Record<string, string | boolean>,
): Promise<void> {
  const { file, source } = await readContextSource(root, contextMarker);
  const fields = parseFrontmatter(source);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  for (const name of Object.keys(values)) {
    if (!fieldsByName.has(name)) throw new Error(`The ${name} frontmatter field does not exist.`);
  }

  let updated = source;
  const changes = Object.entries(values)
    .map(([name, value]) => ({ field: fieldsByName.get(name)!, value }))
    .sort((left, right) => right.field.start - left.field.start);
  for (const { field, value } of changes) {
    const replacement = serializeValue(field, value);
    updated = updated.slice(0, field.start) + replacement + updated.slice(field.end);
  }
  await writeFile(file, updated, 'utf8');
}

async function readContextSource(root: string, token: string): Promise<{ file: string; source: string }> {
  const marker = decodeMarker(token);
  const rootPath = await realpath(root);
  const candidate = path.resolve(rootPath, marker.file);
  if (!isInsideProjectRoot(rootPath, candidate)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  const file = await realpath(candidate);
  if (!isInsideProjectRoot(rootPath, file)) {
    throw new Error('The requested file is outside the Astro project root.');
  }
  if (!['.md', '.mdx', '.mdoc'].includes(path.extname(file).toLowerCase())) {
    throw new Error('This source file has no editable frontmatter.');
  }
  return { file, source: await readFile(file, 'utf8') };
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
    const start = (match.index ?? 0) + match[0].indexOf(match[2]) + match[2].indexOf(original);
    const parsed = parseValue(original);
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

function parseValue(original: string): Pick<FrontmatterField, 'type' | 'value'> {
  if (original === 'true' || original === 'false') {
    return { type: 'boolean', value: original === 'true' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(original)) return { type: 'date', value: original };
  if (/^-?\d+(?:\.\d+)?$/.test(original)) return { type: 'number', value: original };
  if (original.startsWith('[') && original.endsWith(']')) {
    try {
      const value = JSON.parse(original) as unknown;
      if (Array.isArray(value)) return { type: 'list', value: value.map(String).join(', ') };
    } catch {
      return { type: 'string', value: original };
    }
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
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error(`${field.name} must be a number.`);
    return text;
  }
  if (field.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${field.name} must use YYYY-MM-DD.`);
    return text;
  }
  if (field.original.startsWith("'") && field.original.endsWith("'")) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  if (field.original.startsWith('"') && field.original.endsWith('"')) return JSON.stringify(text);
  return /^[\p{L}\p{N}][^:#\[\]{},&*!|>'"%@`]*$/u.test(text) ? text : JSON.stringify(text);
}
