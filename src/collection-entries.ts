import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
} from 'node:fs/promises';
import path from 'node:path';
import { isInsideProjectRoot } from './project-path.ts';
import type { BeforeTextFileWrite } from './source-file.ts';

const CONFIG_NAMES = ['content.config.ts', 'content.config.mts', 'content.config.js', 'content.config.mjs'];
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_ENTRY_FILES = 2_000;
const MAX_BODY_LENGTH = 100_000;

export type CollectionFieldType = 'boolean' | 'date' | 'list' | 'number' | 'string';

export interface CollectionFieldDefinition {
  name: string;
  type: CollectionFieldType;
  required: boolean;
  defaultValue?: string | boolean;
}

export interface WritableContentCollection {
  name: string;
  directory: string;
  extension: '.md' | '.mdx';
  entryStyle: 'flat' | 'index';
  fields: CollectionFieldDefinition[];
  routePattern?: string;
  routeGuidancePattern?: string;
  omittedFields?: Array<{ name: string; reason: string }>;
}

export interface UnsupportedContentCollection {
  name: string;
  reason: string;
}

export interface ContentCollectionDiscovery {
  writable: WritableContentCollection[];
  unsupported: UnsupportedContentCollection[];
}

export interface CreateContentCollectionEntryRequest {
  collection: string;
  slug: string;
  values: Record<string, string | boolean>;
  body: string;
}

export interface CreatedContentCollectionEntry {
  collection: string;
  slug: string;
  file: string;
  route?: string;
  routeGuidance?: string;
}

export class CollectionEntryError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CollectionEntryError';
    this.status = status;
  }
}

interface ParsedCollection extends WritableContentCollection {
  absoluteDirectory: string;
}

interface ParsedFieldResult {
  field?: CollectionFieldDefinition;
  reason?: string;
}

export async function discoverContentCollections(
  projectRoot: string,
  sourceRoot: string,
): Promise<ContentCollectionDiscovery> {
  const parsed = await inspectCollections(projectRoot, sourceRoot);
  return {
    writable: parsed.writable.map(({ absoluteDirectory: _absoluteDirectory, ...collection }) => collection),
    unsupported: parsed.unsupported,
  };
}

export async function createContentCollectionEntry(
  projectRoot: string,
  sourceRoot: string,
  request: CreateContentCollectionEntryRequest,
  onBeforeWrite?: BeforeTextFileWrite,
): Promise<CreatedContentCollectionEntry> {
  validateCreateRequest(request);
  const discovery = await inspectCollections(projectRoot, sourceRoot);
  const collection = discovery.writable.find(({ name }) => name === request.collection);
  if (!collection) {
    const unsupported = discovery.unsupported.find(({ name }) => name === request.collection);
    if (unsupported) throw new CollectionEntryError(unsupported.reason);
    throw new CollectionEntryError(`The ${request.collection} collection is not writable.`);
  }
  const values = serializeCollectionValues(collection.fields, request.values);
  const body = validateStarterBody(request.body, collection.extension);
  await mkdir(collection.absoluteDirectory, { recursive: true });
  const [sourcePath, collectionRoot, contentRoot] = await Promise.all([
    realpath(sourceRoot),
    realpath(collection.absoluteDirectory),
    realpath(path.join(sourceRoot, 'content')),
  ]);
  /* c8 ignore next 4 -- this revalidation closes a local symlink race after static discovery. */
  if (!isInsideProjectRoot(sourcePath, contentRoot)
    || !isInsideProjectRoot(contentRoot, collectionRoot)) {
    throw new CollectionEntryError('The collection directory is linked outside the approved content directory.', 403);
  }
  if (await collectionSlugExists(collectionRoot, request.slug, collection.entryStyle)) {
    throw new CollectionEntryError(`An entry with the slug ${request.slug} already exists in ${collection.name}.`, 409);
  }

  const entryDirectory = collection.entryStyle === 'index'
    ? path.join(collectionRoot, request.slug)
    : collectionRoot;
  let createdEntryDirectory = false;
  if (collection.entryStyle === 'index') {
    try {
      await mkdir(entryDirectory, { recursive: false });
      createdEntryDirectory = true;
    } catch (error) {
      /* c8 ignore next -- mkdir failures other than an existing slug directory are host I/O failures. */
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const verifiedEntryDirectory = await realpath(entryDirectory);
  if (!isInsideProjectRoot(collectionRoot, verifiedEntryDirectory)) {
    throw new CollectionEntryError('The entry directory is linked outside its collection.', 403);
  }
  const fileName = collection.entryStyle === 'index'
    ? `index${collection.extension}`
    : `${request.slug}${collection.extension}`;
  const filePath = path.join(verifiedEntryDirectory, fileName);
  const source = `---\n${values.join('\n')}\n---\n\n${body}\n`;

  try {
    await onBeforeWrite?.(filePath, source);
    await createTextFileExclusive(filePath, source);
  } catch (error) {
    if (createdEntryDirectory) await rmdir(entryDirectory).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CollectionEntryError(`An entry with the slug ${request.slug} already exists in ${collection.name}.`, 409);
    }
    throw error;
  }

  const relativeFile = path.relative(await realpath(projectRoot), filePath).split(path.sep).join('/');
  return {
    collection: collection.name,
    slug: request.slug,
    file: relativeFile,
    route: collection.routePattern?.replace('{slug}', request.slug),
    ...(collection.routeGuidancePattern
      ? { routeGuidance: collection.routeGuidancePattern.replaceAll('{slug}', request.slug) }
      : {}),
  };
}

async function inspectCollections(
  projectRoot: string,
  sourceRoot: string,
): Promise<{ writable: ParsedCollection[]; unsupported: UnsupportedContentCollection[] }> {
  const [rootPath, sourcePath] = await Promise.all([realpath(projectRoot), realpath(sourceRoot)]);
  if (!isInsideProjectRoot(rootPath, sourcePath)) {
    throw new CollectionEntryError('The Astro source directory is outside the project root.', 403);
  }
  const contentRoot = path.join(sourcePath, 'content');
  const contentPath = await verifyProspectiveDirectory(sourcePath, contentRoot).catch(() => undefined);
  if (!contentPath) {
    throw new CollectionEntryError('The content directory is linked outside the Astro source directory.', 403);
  }
  const configPath = await findContentConfig(sourcePath);
  if (!configPath) {
    return {
      writable: [],
      unsupported: [{ name: 'Content collections', reason: 'No src/content.config file was found.' }],
    };
  }
  const source = await readBoundedText(configPath, MAX_CONFIG_BYTES);
  const definitions = parseCollectionDefinitions(source);
  const exports = parseCollectionExports(source);
  if (!exports.length) {
    return {
      writable: [],
      unsupported: [{ name: 'Content collections', reason: 'The content config does not export a static collections object.' }],
    };
  }

  const writable: ParsedCollection[] = [];
  const unsupported: UnsupportedContentCollection[] = [];
  for (const { name, variable } of exports) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      unsupported.push({ name, reason: 'Collection names must use letters, numbers, hyphens, or underscores.' });
      continue;
    }
    const definition = definitions.get(variable);
    if (!definition) {
      unsupported.push({ name, reason: `The ${name} collection definition is dynamic or could not be inspected safely.` });
      continue;
    }
    const parsed = await inspectCollectionDefinition(rootPath, sourcePath, contentPath, name, definition);
    if ('reason' in parsed) unsupported.push({ name, reason: parsed.reason });
    else writable.push(parsed);
  }
  return { writable, unsupported };
}

async function inspectCollectionDefinition(
  root: string,
  sourceRoot: string,
  contentRoot: string,
  name: string,
  definition: string,
): Promise<ParsedCollection | { reason: string }> {
  const collectionProperties = objectProperties(callArgument(definition, 'defineCollection')!);
  const loader = collectionProperties.get('loader');
  const loaderArgument = loader && callArgument(loader, 'glob');
  if (!loaderArgument) {
    return { reason: 'Loader-backed collections are read-only unless they use a static local glob() loader.' };
  }
  const loaderProperties = objectProperties(loaderArgument);
  const base = parseStaticString(loaderProperties.get('base'));
  const pattern = parseStaticString(loaderProperties.get('pattern'));
  if (!base || !pattern) {
    return { reason: 'The local glob loader needs literal base and pattern values before entries can be created.' };
  }
  const extensions = patternExtensions(pattern);
  if (!extensions.length) {
    return { reason: 'The glob pattern does not declare Markdown or MDX entry files.' };
  }
  const directory = path.resolve(root, base);
  if (!isInsideProjectRoot(contentRoot, directory) || directory === contentRoot) {
    return { reason: 'The glob base is outside a dedicated src/content collection directory.' };
  }
  const safeDirectory = await verifyProspectiveDirectory(contentRoot, directory).catch(() => undefined);
  if (!safeDirectory) {
    return { reason: 'The collection directory is linked outside the approved content directory.' };
  }

  const schema = collectionProperties.get('schema');
  const schemaArgument = schema && callArgument(schema, 'z.object');
  if (!schemaArgument || hasUnsupportedObjectEntries(schemaArgument)) {
    return { reason: 'The collection schema is not a static z.object() with explicit fields and cannot be rendered safely.' };
  }
  const fields: CollectionFieldDefinition[] = [];
  const omittedFields: Array<{ name: string; reason: string }> = [];
  for (const [fieldName, expression] of objectProperties(schemaArgument)) {
    if (!/^[A-Za-z_][\w-]*$/.test(fieldName)) {
      return { reason: `The schema field ${fieldName} has an unsupported name.` };
    }
    const parsed = parseSchemaField(fieldName, expression);
    if (parsed.field) fields.push(parsed.field);
    else if (isOptionalExpression(expression)) {
      omittedFields.push({ name: fieldName, reason: parsed.reason! });
    } else {
      return { reason: `The required ${fieldName} field is unsupported. ${parsed.reason!}`.trim() };
    }
  }
  if (!fields.length) return { reason: 'The collection schema has no supported fields.' };

  const convention = await inferEntryConvention(safeDirectory, extensions);
  const route = await detectRoute(sourceRoot, name);
  return {
    name,
    directory: path.relative(root, safeDirectory).split(path.sep).join('/'),
    extension: convention.extension,
    entryStyle: convention.entryStyle,
    fields,
    ...route,
    ...(omittedFields.length ? { omittedFields } : {}),
    absoluteDirectory: safeDirectory,
  };
}

function parseCollectionDefinitions(source: string): Map<string, string> {
  const definitions = new Map<string, string>();
  const pattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*defineCollection\s*\(/g;
  for (const match of maskNonCode(source).matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = matchingDelimiter(source, open);
    if (close > open) definitions.set(match[1], `defineCollection(${source.slice(open + 1, close)})`);
  }
  return definitions;
}

function parseCollectionExports(source: string): Array<{ name: string; variable: string }> {
  const match = /\bexport\s+const\s+collections\s*=\s*\{/.exec(maskNonCode(source));
  if (!match) return [];
  const open = match.index + match[0].lastIndexOf('{');
  const close = matchingDelimiter(source, open);
  /* c8 ignore next -- Astro does not load a content config with an unterminated export object. */
  if (close < 0) return [];
  const entries = objectProperties(source.slice(open, close + 1));
  return [...entries].flatMap(([name, expression]) => (
    /^[A-Za-z_$][\w$]*$/.test(expression.trim())
      ? [{ name, variable: expression.trim() }]
      : []
  ));
}

function parseSchemaField(name: string, rawExpression: string): ParsedFieldResult {
  let expression = removeCodeWhitespace(rawExpression);
  let defaultValue: string | boolean | undefined;
  const defaultMatch = /\.default\(([^()]*)\)$/.exec(expression);
  if (defaultMatch) {
    defaultValue = parseDefaultValue(defaultMatch[1]);
    if (defaultValue === undefined) return { reason: 'Its default value is not a static string, number, or boolean.' };
    expression = expression.slice(0, defaultMatch.index);
  }
  const optional = expression.endsWith('.optional()');
  if (optional) expression = expression.slice(0, -'.optional()'.length);
  const type: CollectionFieldType | undefined = expression === 'z.string()'
    ? 'string'
    : expression === 'z.number()'
      ? 'number'
      : expression === 'z.boolean()'
        ? 'boolean'
        : expression === 'z.coerce.date()'
          ? 'date'
          : expression === 'z.array(z.string())'
            ? 'list'
            : undefined;
  if (!type) return { reason: 'Use string, number, boolean, coerced date, or string-array fields.' };
  if (defaultValue !== undefined && !defaultMatchesType(defaultValue, type)) {
    return { reason: 'Its default value does not match the supported field type.' };
  }
  return {
    field: {
      name,
      type,
      required: !optional && defaultValue === undefined,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    },
  };
}

function isOptionalExpression(expression: string): boolean {
  return /\.(?:optional|default)\s*\(/.test(expression);
}

function parseDefaultValue(source: string): string | boolean | undefined {
  const value = source.trim();
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  return parseStaticString(value);
}

function defaultMatchesType(value: string | boolean, type: CollectionFieldType): boolean {
  if (type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  if (type === 'number') return /^-?\d+(?:\.\d+)?$/.test(value);
  if (type === 'date') return isValidDate(value);
  if (type === 'list') return false;
  return true;
}

function validateCreateRequest(request: CreateContentCollectionEntryRequest): void {
  if (!request || typeof request !== 'object'
    || typeof request.collection !== 'string'
    || typeof request.slug !== 'string'
    || !request.values || typeof request.values !== 'object' || Array.isArray(request.values)
    || typeof request.body !== 'string') {
    throw new CollectionEntryError('The collection entry request is incomplete.');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.slug) || request.slug.length > 100) {
    throw new CollectionEntryError('The slug or filename must use 1-100 lowercase letters, numbers, and single hyphens.');
  }
}

function serializeCollectionValues(
  fields: CollectionFieldDefinition[],
  values: Record<string, string | boolean>,
): string[] {
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  for (const name of Object.keys(values)) {
    if (!fieldsByName.has(name)) throw new CollectionEntryError(`${name} is not a field in this collection.`);
  }
  const serialized: string[] = [];
  for (const field of fields) {
    const supplied = values[field.name];
    const value = supplied === undefined || supplied === '' ? field.defaultValue : supplied;
    if (value === undefined) {
      if (field.required) throw new CollectionEntryError(`${field.name} is required.`);
      continue;
    }
    serialized.push(`${field.name}: ${serializeFieldValue(field, value)}`);
  }
  return serialized;
}

function serializeFieldValue(field: CollectionFieldDefinition, value: string | boolean): string {
  if (field.type === 'boolean') {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    throw new CollectionEntryError(`${field.name} must be true or false.`);
  }
  const text = String(value).trim();
  if (!text && field.required) throw new CollectionEntryError(`${field.name} is required.`);
  if (field.type === 'number') {
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new CollectionEntryError(`${field.name} must be a number.`);
    return text;
  }
  if (field.type === 'date') {
    if (!isValidDate(text)) throw new CollectionEntryError(`${field.name} must be a real date using YYYY-MM-DD.`);
    return text;
  }
  if (field.type === 'list') {
    const items = text.split(',').map((item) => item.trim());
    if (!items.length || items.some((item) => !item || item.length > 200)) {
      throw new CollectionEntryError(`${field.name} must be a comma-separated list of non-empty values.`);
    }
    return JSON.stringify(items);
  }
  if (text.length > 10_000) throw new CollectionEntryError(`${field.name} is too long.`);
  return JSON.stringify(text);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateStarterBody(body: string, extension: '.md' | '.mdx'): string {
  const value = body.trim();
  if (!value) throw new CollectionEntryError('Add a starter body before creating the entry.');
  if (value.length > MAX_BODY_LENGTH || value.includes('\0')) {
    throw new CollectionEntryError('The starter body is too large or contains invalid text.', 413);
  }
  if (extension === '.mdx' && (/[{}]/.test(value) || /<\/?[A-Za-z]/.test(value))) {
    throw new CollectionEntryError('The MDX starter body must be plain text without expressions or JSX.');
  }
  return value;
}

async function collectionSlugExists(
  collectionRoot: string,
  slug: string,
  entryStyle: 'flat' | 'index',
): Promise<boolean> {
  const candidates = entryStyle === 'index'
    ? [path.join(collectionRoot, slug, 'index.md'), path.join(collectionRoot, slug, 'index.mdx')]
    : [path.join(collectionRoot, `${slug}.md`), path.join(collectionRoot, `${slug}.mdx`)];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch (error) {
      /* c8 ignore next -- access failures other than a missing candidate are host I/O failures. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function inferEntryConvention(
  directory: string,
  extensions: Array<'.md' | '.mdx'>,
): Promise<{ extension: '.md' | '.mdx'; entryStyle: 'flat' | 'index' }> {
  const files = await listEntryFiles(directory);
  const matching = files.filter((file) => extensions.includes(path.extname(file).toLowerCase() as '.md' | '.mdx'));
  const extensionCounts = new Map(extensions.map((extension) => [
    extension,
    matching.filter((file) => path.extname(file).toLowerCase() === extension).length,
  ]));
  const extension = [...extensionCounts].sort((left, right) => right[1] - left[1])[0][0];
  const indexCount = matching.filter((file) => path.basename(file).toLowerCase() === `index${path.extname(file).toLowerCase()}`).length;
  return { extension, entryStyle: indexCount > matching.length - indexCount ? 'index' : 'flat' };
}

async function listEntryFiles(directory: string): Promise<string[]> {
  try {
    const root = await realpath(directory);
    const files: string[] = [];
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(candidate);
        else if (entry.isFile()) files.push(candidate);
        if (files.length + queue.length > MAX_ENTRY_FILES) {
          throw new CollectionEntryError('The collection has too many files to infer a safe naming convention.', 413);
        }
      }
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    /* c8 ignore next -- readable collection directories are established before this scan. */
    throw error;
  }
}

async function detectRoute(
  sourceRoot: string,
  collection: string,
): Promise<{ routePattern?: string; routeGuidancePattern?: string }> {
  for (const parameter of ['slug', 'id']) {
    const file = path.join(sourceRoot, 'pages', collection, `[${parameter}].astro`);
    try {
      const source = await readBoundedText(file, MAX_CONFIG_BYTES);
      if (new RegExp(`getCollection\\(\\s*(['"])${escapeRegExp(collection)}\\1\\s*\\)`).test(source)) {
        const routePattern = `/${collection}/{slug}/`;
        if (/export\s+const\s+prerender\s*=\s*false\b/.test(source)) return { routePattern };
        return {
          routeGuidancePattern: `Restart Astro so getStaticPaths includes the new entry, then open ${routePattern}`,
        };
      }
    } catch (error) {
      /* c8 ignore next -- route candidates are either readable source files or absent. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return {};
}

async function verifyProspectiveDirectory(approvedRoot: string, candidate: string): Promise<string> {
  /* c8 ignore next 3 -- all callers perform the same lexical boundary check before resolving links. */
  if (!isInsideProjectRoot(approvedRoot, candidate)) {
    throw new CollectionEntryError('The collection directory is outside the approved content directory.', 403);
  }
  const [approvedExisting, candidateExisting] = await Promise.all([
    nearestExistingRealpath(approvedRoot),
    nearestExistingRealpath(candidate),
  ]);
  if (!isInsideProjectRoot(approvedExisting, candidateExisting)) {
    throw new CollectionEntryError('The collection directory is outside the approved content directory.', 403);
  }
  return candidate;
}

async function nearestExistingRealpath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      /* c8 ignore next -- realpath failures other than a missing prospective directory are host I/O failures. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      /* c8 ignore next -- absolute project paths always reach an existing filesystem root. */
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function createTextFileExclusive(filePath: string, source: string): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(source, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function findContentConfig(sourceRoot: string): Promise<string | undefined> {
  for (const name of CONFIG_NAMES) {
    const file = path.join(sourceRoot, name);
    try {
      await access(file);
      return file;
    } catch (error) {
      /* c8 ignore next -- config candidates are either readable files or absent. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function readBoundedText(file: string, maxBytes: number): Promise<string> {
  const source = await readFile(file, 'utf8');
  if (Buffer.byteLength(source) > maxBytes) throw new CollectionEntryError('The content configuration is too large to inspect safely.', 413);
  return source;
}

function patternExtensions(pattern: string): Array<'.md' | '.mdx'> {
  const extensions: Array<'.md' | '.mdx'> = [];
  if (/(?:^|[^A-Za-z])md(?:[^A-Za-z]|$)/i.test(pattern)) extensions.push('.md');
  if (/(?:^|[^A-Za-z])mdx(?:[^A-Za-z]|$)/i.test(pattern)) extensions.push('.mdx');
  return extensions;
}

function callArgument(expression: string, callName: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(callName).replace('\\.', '\\s*\\.\\s*')}\\s*\\(`);
  const match = pattern.exec(expression);
  if (!match) return undefined;
  const open = expression.indexOf('(', match.index);
  const close = matchingDelimiter(expression, open);
  /* c8 ignore next -- recognized calls come from an Astro-loaded, syntactically valid config. */
  if (close < 0 || expression.slice(close + 1).trim()) return undefined;
  return expression.slice(open + 1, close);
}

function hasUnsupportedObjectEntries(expression: string): boolean {
  const value = stripComments(expression).trim();
  /* c8 ignore next -- z.object arguments come from an Astro-loaded, syntactically valid config. */
  if (!value.startsWith('{') || matchingDelimiter(value, 0) !== value.length - 1) return true;
  return splitTopLevel(value.slice(1, -1), ',').some((part) => {
    const entry = part.trim();
    if (!entry) return false;
    const colon = topLevelIndex(entry, ':');
    if (colon < 0) return true;
    const rawName = entry.slice(0, colon).trim();
    return parseStaticString(rawName) === undefined && !/^[A-Za-z_$][\w$-]*$/.test(rawName);
  });
}

function objectProperties(expression: string): Map<string, string> {
  const value = stripComments(expression).trim();
  /* c8 ignore next -- inspected object arguments come from recognized valid calls. */
  if (!value.startsWith('{')) return new Map();
  const close = matchingDelimiter(value, 0);
  /* c8 ignore next -- Astro rejects unterminated or trailing object syntax before discovery. */
  if (close !== value.length - 1) return new Map();
  const properties = new Map<string, string>();
  for (const part of splitTopLevel(value.slice(1, -1), ',')) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = topLevelIndex(entry, ':');
    if (colon < 0) {
      if (/^[A-Za-z_$][\w$]*$/.test(entry)) properties.set(entry, entry);
      continue;
    }
    const rawName = entry.slice(0, colon).trim();
    const name = parseStaticString(rawName) ?? (/^[A-Za-z_$][\w$-]*$/.test(rawName) ? rawName : undefined);
    if (name) properties.set(name, entry.slice(colon + 1).trim());
  }
  return properties;
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  walkSource(source, (index, depth) => {
    if (depth === 0 && source[index] === delimiter) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  });
  parts.push(source.slice(start));
  return parts;
}

function topLevelIndex(source: string, character: string): number {
  let found = -1;
  walkSource(source, (index, depth) => {
    if (found < 0 && depth === 0 && source[index] === character) found = index;
  });
  return found;
}

function matchingDelimiter(source: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const expected = pairs[source[open]];
  /* c8 ignore next -- callers pass only known opening delimiters. */
  if (!expected) return -1;
  let result = -1;
  walkSource(source.slice(open), (relative, depth) => {
    if (result < 0 && relative > 0 && depth === 0 && source[open + relative] === expected) result = open + relative;
  }, source[open]);
  return result;
}

function walkSource(
  source: string,
  visit: (index: number, depth: number) => void,
  initialOpen?: string,
): void {
  const stack: string[] = initialOpen ? [initialOpen] : [];
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  for (let index = initialOpen ? 1 : 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      index = skipString(source, index, character);
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      /* c8 ignore next -- a valid call cannot close inside a final line comment. */
      if (index < 0) return;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      /* c8 ignore next -- Astro rejects unterminated block comments before discovery. */
      if (end < 0) return;
      index = end + 1;
      continue;
    }
    if (pairs[character]) {
      visit(index, stack.length);
      stack.push(character);
      continue;
    }
    if (stack.length && pairs[stack.at(-1)!] === character) {
      stack.pop();
      visit(index, stack.length);
      continue;
    }
    visit(index, stack.length);
  }
}

function skipString(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === quote) return index;
  }
  /* c8 ignore next -- Astro rejects unterminated string literals before discovery. */
  return source.length;
}

function stripComments(source: string): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const end = skipString(source, index, character);
      result += source.slice(index, end + 1);
      index = end;
    } else if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2);
      /* c8 ignore next -- object expressions do not end inside line comments. */
      if (end < 0) break;
      result += '\n';
      index = end;
    } else if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      /* c8 ignore next -- Astro rejects unterminated block comments before discovery. */
      if (end < 0) break;
      result += ' ';
      index = end + 1;
    } else {
      result += character;
    }
  }
  return result;
}

function removeCodeWhitespace(source: string): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === '`') {
      const end = skipString(source, index, character);
      result += source.slice(index, end + 1);
      index = end;
    } else if (!/\s/.test(character)) {
      result += character;
    }
  }
  return result;
}

function maskNonCode(source: string): string {
  const characters = source.split('');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    let end = -1;
    if (character === '"' || character === "'" || character === '`') {
      end = skipString(source, index, character);
    } else if (character === '/' && source[index + 1] === '/') {
      end = source.indexOf('\n', index + 2);
      if (end < 0) end = source.length - 1;
    } else if (character === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      /* c8 ignore next -- Astro rejects unterminated block comments before discovery. */
      end = commentEnd < 0 ? source.length - 1 : commentEnd + 1;
    }
    if (end < index) continue;
    for (let masked = index; masked <= end; masked += 1) {
      if (characters[masked] !== '\n' && characters[masked] !== '\r') characters[masked] = ' ';
    }
    index = end;
  }
  return characters.join('');
}

function parseStaticString(expression: string | undefined): string | undefined {
  const value = expression?.trim();
  /* c8 ignore next -- non-literals are rejected as one bounded unsupported case. */
  if (!value || !['"', "'", '`'].includes(value[0]) || value.at(-1) !== value[0]) return undefined;
  if (value[0] === '`' && value.includes('${')) return undefined;
  const inner = value.slice(1, -1);
  try {
    if (value[0] === '"') return JSON.parse(value) as string;
    return inner.replace(/\\([\\'"`])/g, '$1');
  } catch {
    /* c8 ignore next -- malformed JSON string literals are syntax errors in loaded configs. */
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
