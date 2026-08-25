import { readFileSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AstroConfig, AstroIntegration } from 'astro';
import { unified } from '@astrojs/markdown-remark';
import type { Plugin, ViteDevServer } from 'vite';
import { annotateAstroSourceLocations, resolveAstroSourceMarker } from './astro-transform.ts';
import { ExpectedTextFileWrites } from './expected-writes.ts';
import {
  DEFAULT_IMAGE_MAX_BYTES,
  ImageAssetError,
  imageUploadEndpoint,
  normalizeImageAssetDirectory,
  resolveExistingImageAsset,
  storeImageAsset,
} from './image-assets.ts';
import {
  FrontmatterEditError,
  readFrontmatterFields,
  updateFrontmatterFields,
  type FrontmatterChange,
} from './frontmatter.ts';
import {
  applySourceEdit,
  applySourceContentBlockEdit,
  applySourceImageInsert,
  applySourceIframeInsert,
  applySourceIframeReplacement,
  applySourceImageReplacement,
  applySourceStructureEdit,
  applySourceVideoInsert,
  applySourceVideoReplacement,
  SourceEditError,
  type SourceEdit,
  type SourceContentBlockEdit,
  type SourceStructureEdit,
  type SourceIframeEdit,
  type SourceVideoInsert,
  type SourceVideoReplacement,
} from './persist.ts';
import { decodeMarker } from './marker.ts';
import { IframeRuleError, normalizeIframeOrigins, validateIframeFields } from './iframe-rules.ts';
import { rehypeEditableBlocks, remarkEditableMedia } from './rehype.ts';
import type { BeforeTextFileWrite } from './source-file.ts';
import {
  CollectionEntryError,
  createContentCollectionEntry,
  discoverContentCollections,
  type CreateContentCollectionEntryRequest,
} from './collection-entries.ts';
import {
  DEFAULT_VIDEO_MAX_BYTES,
  VideoAssetError,
  normalizeVideoAssetDirectory,
  resolveExistingVideoAsset,
  storeVideoAsset,
  videoUploadEndpoint,
} from './video-assets.ts';

export interface WysiwygOptions {
  endpoint?: string;
  imageDirectory?: string;
  videoDirectory?: string;
  iframeOrigins?: string[];
  saveDelay?: number;
}

const DEFAULT_ENDPOINT = '/_astro-wysiwyg/save';
const CONTENT_CHANGE_SETTLE_MS = 50;
const CONTENT_RELOAD_SUPPRESSION_MS = 1_000;

export default function wysiwyg(options: WysiwygOptions = {}): AstroIntegration {
  const endpoint = normalizeEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
  const imageDirectory = normalizeImageAssetDirectory(options.imageDirectory ?? 'assets');
  const videoDirectory = normalizeVideoAssetDirectory(options.videoDirectory ?? 'assets');
  const iframeOrigins = normalizeIframeOrigins(options.iframeOrigins);
  const saveDelay = options.saveDelay ?? 500;
  const editorWrites = createEditorWriteHotUpdateFilter();
  let projectRoot = '';
  let publicRoot = '';
  let sourceRoot = '';

  return {
    name: 'astro-wysiwyg',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig, injectScript, addDevToolbarApp }) => {
        if (command !== 'dev') return;
        projectRoot = fileURLToPath(config.root);
        publicRoot = fileURLToPath(config.publicDir ?? new URL('./public/', config.root));
        sourceRoot = fileURLToPath(config.srcDir);
        editorWrites.setContentRoot(path.join(sourceRoot, 'content'));
        const processor = getMarkdownProcessor(config.markdown)
          ?? (config.markdown?.processor?.name === 'satteri' ? unified() : undefined);
        if (processor) addMarkdownPlugins(processor, projectRoot);
        updateConfig({
          markdown: processor
            ? { processor }
            : {
              remarkPlugins: [[remarkEditableMedia, { root: projectRoot }]],
              rehypePlugins: [[rehypeEditableBlocks, { root: projectRoot }]],
            },
          vite: {
            plugins: [
              ...(astroMajorVersion() >= 7 ? [createAstroSourceAnnotationPlugin(projectRoot)] : []),
              editorWrites.plugin,
            ],
          },
        });
        injectScript(
          'page',
          `import { startEditor } from 'astro-wysiwyg/client'; startEditor(${JSON.stringify({ endpoint, saveDelay, iframeOrigins })});`,
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
        registerSaveEndpoint(
          server,
          endpoint,
          projectRoot,
          publicRoot,
          sourceRoot,
          imageDirectory,
          videoDirectory,
          iframeOrigins,
          editorWrites.onBeforeWrite,
        );
      },
    },
  };
}

function registerSaveEndpoint(
  server: ViteDevServer,
  endpoint: string,
  root: string,
  publicRoot: string,
  sourceRoot: string,
  imageDirectory: string,
  videoDirectory: string,
  iframeOrigins: readonly string[],
  onBeforeWrite: BeforeTextFileWrite,
): void {
  server.middlewares.use(async (request, response, next) => {
    const requestUrl = new URL(request.url ?? '/', 'http://astro.local');
    const pathname = requestUrl.pathname;
    const assetEndpoint = imageUploadEndpoint(endpoint);
    const previewEndpoint = `${assetEndpoint}/preview`;
    const videoEndpoint = videoUploadEndpoint(endpoint);
    const videoPreviewEndpoint = `${videoEndpoint}/preview`;
    const iframePreviewEndpoint = `${endpoint}/iframes/preview`;
    if (pathname !== endpoint
      && pathname !== assetEndpoint
      && pathname !== previewEndpoint
      && pathname !== videoEndpoint
      && pathname !== videoPreviewEndpoint
      && pathname !== iframePreviewEndpoint) return next();
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return sendJson(response, 403, { error: 'Source edits are available only from the local machine.' });
    }
    if (!isSameOrigin(request.headers.origin, request.headers.host)
      || isCrossSiteBrowserRequest(request.headers['sec-fetch-site'])) {
      return sendJson(response, 403, { error: 'The edit request came from another origin.' });
    }
    try {
      if (pathname === previewEndpoint) {
        if (request.method !== 'GET') {
          return sendJson(response, 405, { error: 'Use GET to preview a project image.' });
        }
        const marker = requestUrl.searchParams.get('marker') ?? '';
        const reference = requestUrl.searchParams.get('reference') ?? '';
        if (marker.length > 20_000 || reference.length > 2_000) {
          throw new ImageAssetError('The image preview request is too large.', 413);
        }
        const asset = await resolveExistingImageAsset({
          projectRoot: root,
          publicRoot,
          sourceRoot,
          sourceFile: sourceFileFromMarker(marker),
          reference,
        });
        return sendImage(response, asset.contentType, asset.bytes);
      }
      if (pathname === videoPreviewEndpoint) {
        if (request.method !== 'GET') {
          return sendJson(response, 405, { error: 'Use GET to preview a project video.' });
        }
        const reference = requestUrl.searchParams.get('reference') ?? '';
        if (reference.length > 2_000) {
          throw new VideoAssetError('The video preview request is too large.', 413);
        }
        const asset = await resolveExistingVideoAsset({ publicRoot, reference });
        return sendJson(response, 200, { url: asset.reference });
      }
      if (pathname === iframePreviewEndpoint) {
        if (request.method !== 'POST') {
          return sendJson(response, 405, { error: 'Use POST to preview an iframe.' });
        }
        const body = await readJsonBody(request);
        if (!isIframeRequest(body, 'insert-iframe-after')) {
          return sendJson(response, 400, { error: 'The iframe preview request is incomplete.' });
        }
        const fields = validateIframeFields(body, iframeOrigins);
        return sendJson(response, 200, { src: fields.src });
      }
      if (request.method !== 'POST') {
        return sendJson(response, 405, { error: 'Use POST for editor changes.' });
      }
      if (pathname === videoEndpoint) {
        const fileName = request.headers['x-astro-wysiwyg-filename'];
        if (typeof fileName !== 'string') {
          throw new VideoAssetError('Choose a destination file name for the video.');
        }
        const contentType = request.headers['content-type'];
        if (typeof contentType !== 'string') {
          throw new VideoAssetError('Choose an H.264 MP4 video.', 415);
        }
        const asset = await storeVideoAsset({
          publicRoot,
          assetDirectory: videoDirectory,
          fileName,
          contentType,
          bytes: await readBinaryBody(request, DEFAULT_VIDEO_MAX_BYTES, VideoAssetError),
        });
        return sendJson(response, 201, { uploaded: true, url: asset.url });
      }
      if (pathname === assetEndpoint) {
        const fileName = request.headers['x-astro-wysiwyg-filename'];
        if (typeof fileName !== 'string') {
          throw new ImageAssetError('Choose a destination file name for the image.');
        }
        const contentType = request.headers['content-type'];
        if (typeof contentType !== 'string') {
          throw new ImageAssetError('Choose a supported PNG, JPEG, GIF, or WebP image.', 415);
        }
        const asset = await storeImageAsset({
          publicRoot,
          assetDirectory: imageDirectory,
          fileName,
          contentType,
          bytes: await readBinaryBody(request, DEFAULT_IMAGE_MAX_BYTES, ImageAssetError),
        });
        return sendJson(response, 201, { uploaded: true, url: asset.url });
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        return sendJson(response, 415, { error: 'The edit request must contain JSON.' });
      }
      const body = await readJsonBody(request);
      if (isCollectionDiscoveryRequest(body)) {
        const discovery = await discoverContentCollections(root, sourceRoot);
        return sendJson(response, 200, {
          collections: discovery.writable,
          unsupported: discovery.unsupported,
        });
      }
      if (isCollectionCreateRequest(body)) {
        const created = await createContentCollectionEntry(root, sourceRoot, body, onBeforeWrite);
        return sendJson(response, 201, { created: true, ...created });
      }
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
      if (isIframeRequest(body, 'replace-iframe')) {
        const result = await applySourceIframeReplacement(
          root, body, iframeOrigins, sourceRoot, onBeforeWrite,
        );
        return sendJson(response, 200, { marker: result.marker });
      }
      if (isIframeRequest(body, 'insert-iframe-after')) {
        const result = await applySourceIframeInsert(
          root, body, iframeOrigins, sourceRoot, onBeforeWrite,
        );
        return sendJson(response, 200, { marker: result.marker });
      }
      if (isVideoReplacementRequest(body)) {
        const asset = await resolveExistingVideoAsset({ publicRoot, reference: body.src });
        if (body.poster) {
          const poster = await resolveExistingImageAsset({
            projectRoot: root,
            publicRoot,
            sourceRoot,
            sourceFile: sourceFileFromMarker(body.marker),
            reference: body.poster,
          });
          if (poster.kind !== 'public') {
            throw new SourceEditError('Choose a poster image from the Astro public directory.', 400);
          }
        }
        const result = await applySourceVideoReplacement(
          root,
          { ...body, src: asset.reference },
          sourceRoot,
          onBeforeWrite,
        );
        return sendJson(response, 200, { marker: result.marker });
      }
      if (isVideoInsertRequest(body)) {
        if (body.poster) {
          const poster = await resolveExistingImageAsset({
            projectRoot: root,
            publicRoot,
            sourceRoot,
            sourceFile: sourceFileFromMarker(body.marker),
            reference: body.poster,
          });
          if (poster.kind !== 'public') {
            throw new SourceEditError('Choose a poster image from the Astro public directory.', 400);
          }
        }
        const result = await applySourceVideoInsert(
          root,
          body,
          `/${videoDirectory}/`,
          sourceRoot,
          onBeforeWrite,
        );
        return sendJson(response, 200, { marker: result.marker });
      }
      if (isImageReplacementRequest(body)) {
        const asset = await resolveExistingImageAsset({
          projectRoot: root,
          publicRoot,
          sourceRoot,
          sourceFile: sourceFileFromMarker(body.marker),
          reference: body.src,
        });
        const result = await applySourceImageReplacement(
          root,
          { ...body, src: asset.reference, assetKind: asset.kind },
          sourceRoot,
          onBeforeWrite,
        );
        return sendJson(response, 200, { marker: result.marker });
      }
      if (isImageInsertRequest(body)) {
        const result = await applySourceImageInsert(
          root,
          body,
          `/${imageDirectory}/`,
          sourceRoot,
          onBeforeWrite,
        );
        return sendJson(response, 200, { marker: result.marker });
      }
      if (isContentBlockEdit(body)) {
        const result = await applySourceContentBlockEdit(root, body, sourceRoot, onBeforeWrite);
        return sendJson(response, 200, { marker: result.marker });
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
      if (error instanceof SourceEditError
        || error instanceof FrontmatterEditError
        || error instanceof ImageAssetError
        || error instanceof VideoAssetError
        || error instanceof IframeRuleError
        || error instanceof CollectionEntryError) {
        return sendJson(response, error.status, { error: error.message });
      }
      /* c8 ignore next -- all integration and source boundaries throw Error instances. */
      const internalError = error instanceof Error ? error : new Error('Unknown editor request failure.');
      server.config.logger.error('[astro-wysiwyg] Editor request failed.', { error: internalError });
      return sendJson(response, 500, { error: 'The editor request could not be completed.' });
    }
  });
}

function astroMajorVersion(): number {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('astro/package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
  return Number.parseInt(packageJson.version?.split('.', 1)[0] ?? '0', 10);
}

function createAstroSourceAnnotationPlugin(root: string): Plugin {
  return {
    name: 'astro-wysiwyg:source-annotations',
    enforce: 'pre',
    transform: {
      order: 'pre',
      async handler(source, id) {
        const file = id.split('?', 1)[0];
        if (path.extname(file).toLowerCase() !== '.astro' || id.includes('?astro&type=')) return;
        const code = await annotateAstroSourceLocations(source, id, root);
        return code ? { code, map: null } : undefined;
      },
    },
  };
}

function createEditorWriteHotUpdateFilter(): {
  plugin: Plugin;
  onBeforeWrite: BeforeTextFileWrite;
  setContentRoot(root: string): void;
} {
  const expectedSources = new ExpectedTextFileWrites();
  let contentRoot = '';
  let quietContentReload = false;
  let contentChangePending = false;
  let contentChangeVersion = 0;
  let contentWriteVersion = 0;
  const pendingContentReloads: Array<() => void> = [];
  const isContentFile = (file: string): boolean => {
    const relative = path.relative(contentRoot, file);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const flushPendingContentReloads = (): void => {
    for (const send of pendingContentReloads.splice(0)) send();
  };
  const stopContentReloadSuppression = (): void => {
    quietContentReload = false;
    contentChangePending = false;
    contentChangeVersion += 1;
    flushPendingContentReloads();
  };
  const cancelContentReloadSuppression = (file: string): void => {
    if (isContentFile(file)) stopContentReloadSuppression();
  };
  return {
    setContentRoot(root) {
      contentRoot = root;
    },
    onBeforeWrite(file, source) {
      expectedSources.add(file, source);
      if (isContentFile(file)) {
        quietContentReload = true;
        const version = ++contentWriteVersion;
        setTimeout(() => {
          if (!quietContentReload || version !== contentWriteVersion) return;
          quietContentReload = false;
          contentChangePending = false;
          contentChangeVersion += 1;
          pendingContentReloads.length = 0;
        }, CONTENT_RELOAD_SUPPRESSION_MS);
      }
    },
    plugin: {
      name: 'astro-wysiwyg:quiet-editor-writes',
      enforce: 'pre',
      configureServer(server) {
        const classifyContentChange = (changedPath: string): void => {
          if (!quietContentReload || !isContentFile(changedPath) || path.extname(changedPath) === '.tmp') return;
          contentChangePending = true;
          const version = ++contentChangeVersion;
          setTimeout(() => {
            if (!quietContentReload || version !== contentChangeVersion) return;
            let file: string;
            let source: string;
            try {
              file = realpathSync(changedPath);
              source = readFileSync(file, 'utf8');
            } catch {
              cancelContentReloadSuppression(changedPath);
              return;
            }
            contentChangePending = false;
            const matched = expectedSources.match(file, source);
            if (matched) pendingContentReloads.length = 0;
            else cancelContentReloadSuppression(file);
          }, CONTENT_CHANGE_SETTLE_MS);
        };
        server.watcher.prependListener('change', classifyContentChange);
        server.watcher.prependListener('add', classifyContentChange);
        const hot = server.environments.client.hot;
        const send = hot.send.bind(hot) as (...args: unknown[]) => void;
        hot.send = ((...args: unknown[]) => {
          const payload = args[0];
          // Keep Astro's content-store update, but skip its redundant unscoped reload.
          if (quietContentReload
            && payload
            && typeof payload === 'object'
            && (payload as { type?: string }).type === 'full-reload'
            && (payload as { path?: string }).path === '*'
            && !('triggeredBy' in payload)) {
            pendingContentReloads.push(() => send(...args));
            return;
          }
          send(...args);
        }) as typeof hot.send;
      },
      async handleHotUpdate(context) {
        if (path.extname(context.file) === '.tmp') return [];
        let file: string;
        try {
          file = await realpath(context.file);
        } catch {
          return;
        }
        if (!expectedSources.has(file)) {
          cancelContentReloadSuppression(file);
          return;
        }

        let source: string;
        try {
          source = await context.read();
        } catch {
          expectedSources.discard(file);
          cancelContentReloadSuppression(file);
          return;
        }
        if (!expectedSources.match(file, source)) {
          cancelContentReloadSuppression(file);
          return;
        }
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

function addMarkdownPlugins(processor: ConfiguredMarkdownProcessor, root: string): void {
  const unifiedProcessor = processor as ConfiguredMarkdownProcessor & {
    options: { remarkPlugins?: unknown[]; rehypePlugins: unknown[] };
  };
  unifiedProcessor.options.remarkPlugins ??= [];
  unifiedProcessor.options.remarkPlugins.push([remarkEditableMedia, { root }]);
  unifiedProcessor.options.rehypePlugins.push([rehypeEditableBlocks, { root }]);
}

function isCollectionDiscoveryRequest(value: unknown): value is { collections: 'discover' } {
  return Boolean(value && typeof value === 'object'
    && (value as Record<string, unknown>).collections === 'discover');
}

function isCollectionCreateRequest(value: unknown): value is CreateContentCollectionEntryRequest & {
  collections: 'create';
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.collections === 'create'
    && typeof body.collection === 'string'
    && typeof body.slug === 'string'
    && Boolean(body.values) && typeof body.values === 'object' && !Array.isArray(body.values)
    && Object.values(body.values as Record<string, unknown>).every((item) => (
      typeof item === 'string' || typeof item === 'boolean'
    ))
    && typeof body.body === 'string';
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

function isIframeRequest<T extends 'insert-iframe-after' | 'replace-iframe'>(
  value: unknown,
  operation: T,
): value is SourceIframeEdit & { operation: T } {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.operation === operation
    && typeof body.marker === 'string'
    && typeof body.src === 'string'
    && typeof body.title === 'string'
    && typeof body.width === 'number'
    && typeof body.height === 'number'
    && (body.loading === 'lazy' || body.loading === 'eager')
    && typeof body.referrerPolicy === 'string'
    && Array.isArray(body.allow) && body.allow.every((token) => typeof token === 'string')
    && Array.isArray(body.sandbox) && body.sandbox.every((token) => typeof token === 'string')
    && typeof body.allowFullscreen === 'boolean';
}

function isVideoReplacementRequest(value: unknown): value is SourceVideoReplacement & {
  operation: 'replace-video';
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.operation === 'replace-video'
    && typeof body.marker === 'string'
    && typeof body.src === 'string'
    && typeof body.label === 'string'
    && typeof body.description === 'string'
    && (body.poster === undefined || typeof body.poster === 'string')
    && typeof body.controls === 'boolean'
    && (body.preload === 'auto' || body.preload === 'metadata' || body.preload === 'none')
    && typeof body.muted === 'boolean'
    && typeof body.loop === 'boolean'
    && typeof body.autoplay === 'boolean';
}

function isVideoInsertRequest(value: unknown): value is SourceVideoInsert & {
  operation: 'insert-video-after';
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.operation === 'insert-video-after'
    && typeof body.marker === 'string'
    && typeof body.src === 'string'
    && typeof body.label === 'string'
    && typeof body.description === 'string'
    && (body.poster === undefined || typeof body.poster === 'string')
    && typeof body.controls === 'boolean'
    && (body.preload === 'auto' || body.preload === 'metadata' || body.preload === 'none')
    && typeof body.muted === 'boolean'
    && typeof body.loop === 'boolean'
    && typeof body.autoplay === 'boolean';
}

function isImageReplacementRequest(value: unknown): value is {
  operation: 'replace-image';
  marker: string;
  src: string;
  alt: string;
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.operation === 'replace-image'
    && typeof body.marker === 'string'
    && typeof body.src === 'string'
    && typeof body.alt === 'string';
}

function isImageInsertRequest(value: unknown): value is {
  marker: string;
  src: string;
  alt: string;
} {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return body.operation === 'insert-image-after'
    && typeof body.marker === 'string'
    && typeof body.src === 'string'
    && typeof body.alt === 'string';
}

function isContentBlockEdit(value: unknown): value is SourceContentBlockEdit {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  const valueFields = body.value as Record<string, unknown> | undefined;
  return typeof body.marker === 'string'
    && (body.operation === 'insert-content-after' || body.operation === 'replace-content')
    && ['paragraph', 'heading', 'bulleted-list', 'numbered-list', 'blockquote', 'code-block', 'divider'].includes(String(body.type))
    && (body.value === undefined || Boolean(valueFields)
      && typeof valueFields!.text === 'string'
      && Array.isArray(valueFields!.items)
      && valueFields!.items.every((item) => typeof item === 'string'))
    && (body.confirmedLoss === undefined || typeof body.confirmedLoss === 'boolean')
    && (body.headingLevel === undefined || typeof body.headingLevel === 'number')
    && (body.html === undefined || typeof body.html === 'string')
    && (body.codeLanguage === undefined || typeof body.codeLanguage === 'string');
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

function sourceFileFromMarker(token: string): string {
  try {
    return decodeMarker(token).file;
  } catch {
    throw new SourceEditError('The editor marker is invalid. Reload the page and try again.', 400);
  }
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

function isCrossSiteBrowserRequest(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && value !== 'same-origin' && value !== 'none';
}

function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBinaryBody(
  request: NodeJS.ReadableStream,
  maxBytes: number,
  ErrorType: typeof ImageAssetError | typeof VideoAssetError,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const message = ErrorType === VideoAssetError ? 'The video is too large.' : 'The image is too large.';
      throw new ErrorType(message, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

function sendImage(
  response: { statusCode: number; setHeader(name: string, value: string): void; end(body: Buffer): void },
  contentType: string,
  body: Buffer,
): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
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
