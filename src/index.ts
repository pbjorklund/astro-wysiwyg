import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AstroConfig, AstroIntegration } from 'astro';
import type { Plugin, ViteDevServer } from 'vite';
import { resolveAstroSourceMarker } from './astro-transform.ts';
import {
  FrontmatterEditError,
  readFrontmatterFields,
  updateFrontmatterFields,
  type FrontmatterChange,
} from './frontmatter.ts';
import {
  applySourceEdit,
  applySourceStructureEdit,
  SourceEditError,
  type SourceEdit,
  type SourceStructureEdit,
} from './persist.ts';
import { rehypeEditableBlocks } from './rehype.ts';
import type { BeforeTextFileWrite } from './source-file.ts';

export interface WysiwygOptions {
  endpoint?: string;
  saveDelay?: number;
}

const DEFAULT_ENDPOINT = '/_astro-wysiwyg/save';

export default function wysiwyg(options: WysiwygOptions = {}): AstroIntegration {
  const endpoint = normalizeEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
  const saveDelay = options.saveDelay ?? 500;
  const editorWrites = createEditorWriteHotUpdateFilter();
  let projectRoot = '';
  let sourceRoot = '';

  return {
    name: 'astro-wysiwyg',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig, injectScript, addDevToolbarApp }) => {
        if (command !== 'dev') return;
        projectRoot = fileURLToPath(config.root);
        sourceRoot = fileURLToPath(config.srcDir);
        const processor = getMarkdownProcessor(config.markdown);
        if (processor) addRehypePlugin(processor, projectRoot);
        updateConfig({
          markdown: processor
            ? { processor }
            : { rehypePlugins: [[rehypeEditableBlocks, { root: projectRoot }]] },
          vite: { plugins: [editorWrites.plugin] },
        });
        injectScript(
          'page',
          `import { startEditor } from 'astro-wysiwyg/client'; startEditor(${JSON.stringify({ endpoint, saveDelay })});`,
        );
        addDevToolbarApp({
          id: 'astro-wysiwyg',
          name: 'Page editor',
          icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
          entrypoint: 'astro-wysiwyg/toolbar-app',
        });
      },
      'astro:server:setup': ({ server }) => {
        if (!sourceRoot) return;
        registerSaveEndpoint(server, endpoint, projectRoot, sourceRoot, editorWrites.onBeforeWrite);
      },
    },
  };
}

function registerSaveEndpoint(
  server: ViteDevServer,
  endpoint: string,
  root: string,
  sourceRoot: string,
  onBeforeWrite: BeforeTextFileWrite,
): void {
  server.middlewares.use(async (request, response, next) => {
    const pathname = new URL(request.url ?? '/', 'http://astro.local').pathname;
    if (pathname !== endpoint) return next();
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Use POST to save an edit.' });
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return sendJson(response, 403, { error: 'Source edits are available only from the local machine.' });
    }
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      return sendJson(response, 403, { error: 'The edit request came from another origin.' });
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'The edit request must contain JSON.' });
    }

    try {
      const body = await readJsonBody(request);
      if (isFrontmatterReadRequest(body)) {
        const fields = await readFrontmatterFields(root, body.contextMarker, sourceRoot);
        return sendJson(response, 200, { fields });
      }
      if (isFrontmatterUpdateRequest(body)) {
        await updateFrontmatterFields(root, body.contextMarker, body.changes, sourceRoot);
        return sendJson(response, 200, { saved: true });
      }
      if (isResolveRequest(body)) {
        const marker = await resolveAstroSourceMarker(root, body.sourceFile, body.sourceLocation, {
          contextMarker: body.contextMarker,
          contextHref: body.contextHref,
          renderedText: body.renderedText,
        });
        return sendJson(response, 200, { marker });
      }
      if (isStructureEdit(body)) {
        const result = await applySourceStructureEdit(root, body, sourceRoot, onBeforeWrite);
        return sendJson(response, 200, { marker: result.marker });
      }
      if (!isSourceEdit(body)) throw new SourceEditError('The edit request is incomplete.', 400);
      if (body.html.length > 1_000_000) throw new SourceEditError('This edit is too large to save.', 413);

      const result = await applySourceEdit(root, body, onBeforeWrite, sourceRoot);
      return sendJson(response, 200, { marker: result.marker });
    } catch (error) {
      if (error instanceof SourceEditError || error instanceof FrontmatterEditError) {
        return sendJson(response, error.status, { error: error.message });
      }
      /* c8 ignore next -- all integration and source boundaries throw Error instances. */
      const internalError = error instanceof Error ? error : new Error('Unknown editor request failure.');
      server.config.logger.error('[astro-wysiwyg] Editor request failed.', { error: internalError });
      return sendJson(response, 500, { error: 'The editor request could not be completed.' });
    }
  });
}

function createEditorWriteHotUpdateFilter(): {
  plugin: Plugin;
  onBeforeWrite: BeforeTextFileWrite;
} {
  const expectedSources = new Map<string, string[]>();
  return {
    onBeforeWrite(file, source) {
      expectedSources.set(file, [...(expectedSources.get(file) ?? []), source]);
    },
    plugin: {
      name: 'astro-wysiwyg:quiet-editor-writes',
      enforce: 'pre',
      async handleHotUpdate(context) {
        let file: string;
        try {
          file = await realpath(context.file);
        } catch {
          return;
        }
        const expected = expectedSources.get(file);
        if (!expected?.length) return;

        let source: string;
        try {
          source = await context.read();
        } catch {
          expectedSources.delete(file);
          return;
        }
        const match = expected.lastIndexOf(source);
        if (match < 0) {
          expectedSources.delete(file);
          return;
        }
        const remaining = expected.slice(match + 1);
        if (remaining.length) expectedSources.set(file, remaining);
        else expectedSources.delete(file);
        return [];
      },
    },
  };
}

type ConfiguredMarkdownProcessor = NonNullable<AstroConfig['markdown']['processor']>;

function getMarkdownProcessor(markdown: AstroConfig['markdown'] | undefined): ConfiguredMarkdownProcessor | undefined {
  const processor = markdown?.processor;
  if (!processor || processor.name !== 'unified') return undefined;
  const options = (processor as { options?: { rehypePlugins?: unknown } }).options;
  if (!Array.isArray(options?.rehypePlugins)) return undefined;
  return processor;
}

function addRehypePlugin(processor: ConfiguredMarkdownProcessor, root: string): void {
  const unifiedProcessor = processor as ConfiguredMarkdownProcessor & {
    options: { rehypePlugins: unknown[] };
  };
  unifiedProcessor.options.rehypePlugins.push([rehypeEditableBlocks, { root }]);
}

function isFrontmatterReadRequest(value: unknown): value is {
  frontmatter: 'read';
  contextMarker: string;
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.frontmatter === 'read' && typeof body.contextMarker === 'string';
}

function isFrontmatterUpdateRequest(value: unknown): value is {
  frontmatter: 'update';
  contextMarker: string;
  changes: Record<string, FrontmatterChange>;
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  if (body.frontmatter !== 'update' || typeof body.contextMarker !== 'string') return false;
  if (!body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes)) return false;
  return Object.values(body.changes).every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const change = item as Record<string, unknown>;
    return typeof change.original === 'string'
      && (typeof change.value === 'string' || typeof change.value === 'boolean');
  });
}

function isResolveRequest(value: unknown): value is {
  sourceFile: string;
  sourceLocation: string;
  contextMarker?: string;
  contextHref?: string;
  renderedText?: string;
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return typeof body.sourceFile === 'string'
    && typeof body.sourceLocation === 'string'
    && (body.contextMarker === undefined || typeof body.contextMarker === 'string')
    && (body.contextHref === undefined || typeof body.contextHref === 'string')
    && (body.renderedText === undefined || typeof body.renderedText === 'string');
}

function isStructureEdit(value: unknown): value is SourceStructureEdit {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return typeof body.marker === 'string'
    && (body.operation === 'insert-after' || body.operation === 'delete');
}

function isSourceEdit(value: unknown): value is SourceEdit {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return typeof body.marker === 'string'
    && typeof body.html === 'string'
    && (body.text === undefined || typeof body.text === 'string')
    && (body.tag === undefined || typeof body.tag === 'string');
}

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint.startsWith('/') || endpoint.includes('?') || endpoint.includes('#')) {
    throw new Error('astro-wysiwyg endpoint must be an absolute URL path.');
  }
  return endpoint.length > 1 && endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalized === '::1' || normalized.startsWith('127.');
}

function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJsonBody(request: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_100_000) throw new SourceEditError('This edit is too large to save.', 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SourceEditError('The edit request contains invalid JSON.', 400);
  }
}

function sendJson(
  response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void },
  status: number,
  body: object,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}
