import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import wysiwyg from '../src/index.ts';
import { createMarker, encodeMarker } from '../src/marker.ts';

const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function testMp4(codec = 'avc1'): Buffer {
  const box = (type: string, payload = Buffer.alloc(0)): Buffer => {
    const value = Buffer.alloc(8 + payload.length);
    value.writeUInt32BE(value.length, 0);
    value.write(type, 4, 4, 'ascii');
    payload.copy(value, 8);
    return value;
  };
  const sample = box(codec, Buffer.alloc(78));
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), sample]));
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\u0000\u0000\u0000\u0000isomavc1')),
    box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd))))),
    box('mdat', Buffer.from([0, 0, 0, 1])),
  ]);
}

const TEST_MP4 = testMp4();

type Middleware = (
  request: Readable & {
    method?: string;
    url?: string;
    headers: Record<string, string>;
    socket: { remoteAddress?: string };
  },
  response: TestResponse,
  next: () => void,
) => void | Promise<void>;

interface TestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer;
  setHeader(name: string, value: string): void;
  end(body: string | Buffer): void;
}

async function saveMiddleware(
  root: string,
  options: Parameters<typeof wysiwyg>[0] = {},
  loggedErrors: unknown[] = [],
  sourceRoot = root,
  configuredValues: unknown[] = [],
): Promise<Middleware> {
  const integration = wysiwyg(options);
  const publicRoot = path.join(root, 'public');
  await mkdir(publicRoot, { recursive: true });
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: {
      root: pathToFileURL(`${root}${path.sep}`),
      srcDir: pathToFileURL(`${sourceRoot}${path.sep}`),
      publicDir: pathToFileURL(`${publicRoot}${path.sep}`),
      markdown: {},
    },
    updateConfig: (value: unknown) => {
      configuredValues.push(value);
      return value;
    },
    injectScript: () => undefined,
    addDevToolbarApp: () => undefined,
  } as never);
  let middleware: Middleware | undefined;
  await integration.hooks['astro:server:setup']?.({
    server: {
      config: {
        logger: {
          error: (_message: string, details: { error?: unknown } = {}) => {
            loggedErrors.push(details.error);
          },
        },
      },
      middlewares: { use: (handler: Middleware) => { middleware = handler; } },
    },
  } as never);
  assert.ok(middleware);
  return middleware;
}

async function send(
  middleware: Middleware,
  body: string | Buffer,
  headers: Record<string, string> = {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'application/json',
  },
  requestOptions: { method?: string; remoteAddress?: string | null; url?: string | null } = {},
): Promise<TestResponse> {
  const request = Object.assign(Readable.from([body]), {
    method: requestOptions.method ?? 'POST',
    url: requestOptions.url === null ? undefined : (requestOptions.url ?? '/_astro-wysiwyg/save'),
    headers,
    socket: requestOptions.remoteAddress === null
      ? {}
      : { remoteAddress: requestOptions.remoteAddress ?? '127.0.0.1' },
  });
  return new Promise((resolve, reject) => {
    const response: TestResponse = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name] = value; },
      end(value) { this.body = value; resolve(this); },
    };
    Promise.resolve(middleware(request, response, () => {
      response.body = 'next';
      resolve(response);
    }))
      .catch(reject);
  });
}

test('registers source annotation and client only for the dev command', async () => {
  const integration = wysiwyg();
  const updates: unknown[] = [];
  const scripts: Array<[string, string]> = [];
  const toolbarApps: unknown[] = [];
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: { root: new URL('file:///project/'), srcDir: new URL('file:///project/src/') },
    updateConfig: (value: unknown) => { updates.push(value); return value; },
    injectScript: (stage: string, content: string) => scripts.push([stage, content]),
    addDevToolbarApp: (app: unknown) => toolbarApps.push(app),
  } as never);

  assert.equal(integration.name, 'astro-wysiwyg');
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0]), /rehypePlugins/);
  assert.deepEqual(scripts.map(([stage]) => stage), ['page']);
  assert.match(scripts[0][1], /startEditor/);
  assert.match(scripts[0][1], /"iframeOrigins":\["self"\]/);
  assert.equal(toolbarApps.length, 1);
  assert.match(JSON.stringify(toolbarApps[0]), /astro-wysiwyg/);
});

test('rejects invalid iframe origin configuration before server setup', () => {
  assert.throws(() => wysiwyg({ iframeOrigins: ['*'] }), /exact HTTPS origins/);
  assert.throws(() => wysiwyg({ iframeOrigins: ['http://player.example.com'] }), /exact HTTPS origins/);
});

test('save endpoint persists a same-origin JSON edit', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.md');
  await writeFile(file, 'Old text\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const marker = encodeMarker(createMarker('page.md', 0, 8, 'Old text', 'markdown', 'p'));

  const response = await send(middleware, JSON.stringify({ marker, html: 'New text', tag: 'p' }));

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['Content-Type'], /application\/json/);
  assert.equal(await readFile(file, 'utf8'), 'New text\n');
});

test('suppresses matching editor hot updates without hiding external changes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.md');
  await writeFile(file, 'Old text\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuredValues: unknown[] = [];
  const middleware = await saveMiddleware(root, {}, [], root, configuredValues);
  const firstMarker = encodeMarker(createMarker('page.md', 0, 8, 'Old text', 'markdown', 'p'));
  const first = await send(middleware, JSON.stringify({ marker: firstMarker, html: 'Editor text' }));
  assert.equal(first.statusCode, 200);

  const configured = configuredValues[0] as {
    vite: { plugins: Array<{
      handleHotUpdate(context: { file: string; read(): Promise<string> }): Promise<unknown>;
    }> };
  };
  const filter = configured.vite.plugins.find(({ handleHotUpdate }) => Boolean(handleHotUpdate));
  assert.ok(filter);
  const secondMarker = (JSON.parse(first.body) as { marker: string }).marker;
  const second = await send(middleware, JSON.stringify({ marker: secondMarker, html: 'Newer editor text' }));
  assert.equal(second.statusCode, 200);
  assert.deepEqual(await filter.handleHotUpdate({
    file,
    read: async () => 'Editor text\n',
  }), []);
  assert.deepEqual(await filter.handleHotUpdate({
    file,
    read: () => readFile(file, 'utf8'),
  }), []);
  assert.deepEqual(await filter.handleHotUpdate({
    file,
    read: () => readFile(file, 'utf8'),
  }), []);

  const thirdMarker = (JSON.parse(second.body) as { marker: string }).marker;
  const third = await send(middleware, JSON.stringify({ marker: thirdMarker, html: 'Third editor text' }));
  assert.equal(third.statusCode, 200);
  assert.equal(await filter.handleHotUpdate({
    file,
    read: async () => { throw new Error('Simulated read failure.'); },
  }), undefined);

  const fourthMarker = (JSON.parse(third.body) as { marker: string }).marker;
  const fourth = await send(middleware, JSON.stringify({ marker: fourthMarker, html: 'Fourth editor text' }));
  assert.equal(fourth.statusCode, 200);
  await writeFile(file, 'External text\n');
  assert.equal(await filter.handleHotUpdate({
    file,
    read: () => readFile(file, 'utf8'),
  }), undefined);
  assert.equal(await filter.handleHotUpdate({
    file: path.join(root, 'missing.md'),
    read: async () => '',
  }), undefined);
});

test('suppresses the content data reload caused by an editor write but not external reloads', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const contentRoot = path.join(root, 'content');
  const file = path.join(contentRoot, 'article.md');
  await mkdir(contentRoot, { recursive: true });
  await writeFile(file, 'Old text\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuredValues: unknown[] = [];
  const middleware = await saveMiddleware(root, {}, [], root, configuredValues);
  const configured = configuredValues[0] as {
    vite: { plugins: Array<{
      configureServer?(server: unknown): void;
      handleHotUpdate(context: { file: string; read(): Promise<string> }): Promise<unknown>;
    }> };
  };
  const filter = configured.vite.plugins.find(({ handleHotUpdate }) => Boolean(handleHotUpdate));
  assert.ok(filter?.configureServer);
  const sent: unknown[] = [];
  const hot = { send: (payload: unknown) => { sent.push(payload); } };
  const sourceListeners = new Map<string, (file: string) => void>();
  const watcher = {
    prependListener(event: string, listener: (file: string) => void) {
      assert.ok(event === 'add' || event === 'change');
      sourceListeners.set(event, listener);
    },
  };
  filter.configureServer({ environments: { client: { hot } }, watcher });
  const onSourceChange = (file: string) => sourceListeners.get('change')?.(file);
  onSourceChange(file);

  const marker = encodeMarker(createMarker('content/article.md', 0, 8, 'Old text', 'markdown', 'p'));
  const response = await send(middleware, JSON.stringify({ marker, html: 'Editor text' }));
  assert.equal(response.statusCode, 200);
  hot.send({ type: 'full-reload', path: '*' });
  assert.deepEqual(sent, []);
  const temporaryFile = path.join(contentRoot, '.article.md.temporary.tmp');
  await writeFile(temporaryFile, 'temporary write');
  assert.deepEqual(await filter.handleHotUpdate({
    file: temporaryFile,
    read: () => readFile(temporaryFile, 'utf8'),
  }), []);
  await rm(temporaryFile);
  onSourceChange(temporaryFile);
  onSourceChange(path.join(contentRoot, 'temporarily-missing.md'));
  onSourceChange(file);
  assert.deepEqual(await filter.handleHotUpdate({ file, read: () => readFile(file, 'utf8') }), []);
  hot.send({ type: 'full-reload', path: '*', triggeredBy: file });
  hot.send({ type: 'full-reload', path: '*' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(sent, [{ type: 'full-reload', path: '*', triggeredBy: file }]);

  await writeFile(file, 'External text\n');
  onSourceChange(file);
  hot.send({ type: 'full-reload', path: '*' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(await filter.handleHotUpdate({ file, read: () => readFile(file, 'utf8') }), undefined);
  assert.deepEqual(sent, [
    { type: 'full-reload', path: '*', triggeredBy: file },
    { type: 'full-reload', path: '*' },
  ]);

  const externalMarker = encodeMarker(createMarker(
    'content/article.md',
    0,
    'External text'.length,
    'External text',
    'markdown',
    'p',
  ));
  const missingResponse = await send(middleware, JSON.stringify({
    marker: externalMarker,
    html: 'Editor after missing',
  }));
  assert.equal(missingResponse.statusCode, 200);
  onSourceChange(path.join(contentRoot, 'missing-after-write.md'));
  hot.send({ type: 'full-reload', path: '*' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(sent, [
    { type: 'full-reload', path: '*', triggeredBy: file },
    { type: 'full-reload', path: '*' },
    { type: 'full-reload', path: '*' },
  ]);

  const missingMarker = (JSON.parse(missingResponse.body) as { marker: string }).marker;
  const fallbackResponse = await send(middleware, JSON.stringify({
    marker: missingMarker,
    html: 'Editor before unrelated reload',
  }));
  assert.equal(fallbackResponse.statusCode, 200);
  hot.send({ type: 'full-reload', path: '*' });
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.deepEqual(sent, [
    { type: 'full-reload', path: '*', triggeredBy: file },
    { type: 'full-reload', path: '*' },
    { type: 'full-reload', path: '*' },
  ]);
  hot.send({ type: 'full-reload', path: '*' });
  assert.deepEqual(sent.at(-1), { type: 'full-reload', path: '*' });
});

test('suppresses repeated and coalesced editor writes without consuming later updates', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.md');
  await writeFile(file, 'Old text\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuredValues: unknown[] = [];
  const middleware = await saveMiddleware(root, {}, [], root, configuredValues);
  const configured = configuredValues[0] as {
    vite: { plugins: Array<{
      handleHotUpdate(context: { file: string; read(): Promise<string> }): Promise<unknown>;
    }> };
  };
  const filter = configured.vite.plugins.find(({ handleHotUpdate }) => Boolean(handleHotUpdate));
  assert.ok(filter);

  const firstMarker = encodeMarker(createMarker('page.md', 0, 8, 'Old text', 'markdown', 'p'));
  const first = await send(middleware, JSON.stringify({ marker: firstMarker, html: 'Same editor text' }));
  assert.equal(first.statusCode, 200);
  const secondMarker = (JSON.parse(first.body) as { marker: string }).marker;
  const second = await send(middleware, JSON.stringify({ marker: secondMarker, html: 'Same editor text' }));
  assert.equal(second.statusCode, 200);

  const update = { file, read: () => readFile(file, 'utf8') };
  assert.deepEqual(await filter.handleHotUpdate(update), []);
  assert.deepEqual(await filter.handleHotUpdate(update), []);
  assert.deepEqual(await filter.handleHotUpdate(update), []);

  const thirdMarker = (JSON.parse(second.body) as { marker: string }).marker;
  const third = await send(middleware, JSON.stringify({ marker: thirdMarker, html: 'Skipped editor text' }));
  assert.equal(third.statusCode, 200);
  const fourthMarker = (JSON.parse(third.body) as { marker: string }).marker;
  const fourth = await send(middleware, JSON.stringify({ marker: fourthMarker, html: 'Coalesced editor text' }));
  assert.equal(fourth.statusCode, 200);
  assert.deepEqual(await filter.handleHotUpdate(update), []);
  assert.deepEqual(await filter.handleHotUpdate(update), []);
  await writeFile(file, 'External text\n');
  assert.equal(await filter.handleHotUpdate(update), undefined);
  assert.equal(await filter.handleHotUpdate(update), undefined);
});

test('uploads a validated image and inserts its public reference without combining the writes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-upload-'));
  const file = path.join(root, 'page.md');
  const source = 'Before\n\nAfter\n';
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, { imageDirectory: 'media/editor' });
  const png = TEST_PNG;

  const upload = await send(middleware, png, {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'image/png',
    'x-astro-wysiwyg-filename': 'diagram.png',
  }, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(upload.statusCode, 201);
  assert.deepEqual(JSON.parse(upload.body), { uploaded: true, url: '/media/editor/diagram.png' });
  assert.deepEqual(await readFile(path.join(root, 'public/media/editor/diagram.png')), png);
  const gifUpload = await send(middleware, 'GIF89a;', {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'image/gif',
    'x-astro-wysiwyg-filename': 'animation.gif',
  }, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(gifUpload.statusCode, 201);
  assert.equal(await readFile(file, 'utf8'), source);

  const marker = encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p'));
  const insert = await send(middleware, JSON.stringify({
    marker,
    operation: 'insert-image-after',
    src: '/media/editor/diagram.png',
    alt: 'A project diagram',
  }));
  assert.equal(insert.statusCode, 200);
  assert.match((JSON.parse(insert.body) as { marker: string }).marker, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    await readFile(file, 'utf8'),
    'Before\n\n![A project diagram](/media/editor/diagram.png)\n\nAfter\n',
  );
});

test('uploads a validated H.264 MP4 and inserts native video markup separately', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-'));
  const file = path.join(root, 'page.md');
  const poster = path.join(root, 'public/media/posters/walkthrough.png');
  const source = 'Before\n\nAfter\n';
  await mkdir(path.dirname(poster), { recursive: true });
  await Promise.all([writeFile(file, source), writeFile(poster, TEST_PNG)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, { videoDirectory: 'media/videos' });

  const upload = await send(middleware, TEST_MP4, {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'video/mp4',
    'x-astro-wysiwyg-filename': 'walkthrough.mp4',
  }, { url: '/_astro-wysiwyg/save/videos' });
  assert.equal(upload.statusCode, 201);
  assert.deepEqual(JSON.parse(String(upload.body)), {
    uploaded: true, url: '/media/videos/walkthrough.mp4',
  });
  assert.deepEqual(await readFile(path.join(root, 'public/media/videos/walkthrough.mp4')), TEST_MP4);
  assert.equal(await readFile(file, 'utf8'), source);

  const marker = encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p'));
  const insert = await send(middleware, JSON.stringify({
    marker,
    operation: 'insert-video-after',
    src: '/media/videos/walkthrough.mp4',
    label: 'Product walkthrough',
    description: 'A guided tour of the product dashboard.',
    poster: '/media/posters/walkthrough.png',
    controls: true,
    preload: 'metadata',
    muted: true,
    loop: false,
    autoplay: false,
  }));
  assert.equal(insert.statusCode, 200);
  assert.match((JSON.parse(String(insert.body)) as { marker: string }).marker, /^[A-Za-z0-9_-]+$/);
  const saved = await readFile(file, 'utf8');
  assert.match(saved, /<video controls preload="metadata" aria-label="Product walkthrough" poster="\/media\/posters\/walkthrough\.png" muted playsinline>/);
  assert.match(saved, /<source src="\/media\/videos\/walkthrough\.mp4" type="video\/mp4" \/>/);
  assert.match(saved, /<figcaption>A guided tour of the product dashboard\.<\/figcaption>/);
});

test('rejects invalid video uploads and keeps successful uploads after insertion conflicts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-'));
  const file = path.join(root, 'page.md');
  const source = 'Before\n';
  await Promise.all([
    writeFile(file, source),
    writeFile(path.join(root, 'source-poster.png'), TEST_PNG),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const headers = {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'video/mp4',
    'x-astro-wysiwyg-filename': 'safe.mp4',
  };

  const missingName = await send(middleware, TEST_MP4, {
    host: headers.host, origin: headers.origin, 'content-type': headers['content-type'],
  }, { url: '/_astro-wysiwyg/save/videos' });
  assert.equal(missingName.statusCode, 400);
  const missingType = await send(middleware, TEST_MP4, {
    host: headers.host, origin: headers.origin,
    'x-astro-wysiwyg-filename': headers['x-astro-wysiwyg-filename'],
  }, { url: '/_astro-wysiwyg/save/videos' });
  assert.equal(missingType.statusCode, 415);
  const unsupported = await send(middleware, testMp4('hvc1'), headers, {
    url: '/_astro-wysiwyg/save/videos',
  });
  assert.equal(unsupported.statusCode, 400);
  const wrongType = await send(middleware, TEST_MP4, { ...headers, 'content-type': 'video/webm' }, {
    url: '/_astro-wysiwyg/save/videos',
  });
  assert.equal(wrongType.statusCode, 400);
  const first = await send(middleware, TEST_MP4, headers, { url: '/_astro-wysiwyg/save/videos' });
  assert.equal(first.statusCode, 201);
  const duplicate = await send(middleware, TEST_MP4, headers, { url: '/_astro-wysiwyg/save/videos' });
  assert.equal(duplicate.statusCode, 409);
  const oversized = await send(middleware, Buffer.alloc(100_000_001), headers, {
    url: '/_astro-wysiwyg/save/videos',
  });
  assert.equal(oversized.statusCode, 413);

  const sourcePoster = await send(middleware, JSON.stringify({
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p')),
    operation: 'insert-video-after',
    src: '/assets/safe.mp4',
    label: 'Source poster video',
    description: 'A source-relative poster is not portable in native markup.',
    poster: 'source-poster.png',
    controls: true,
    preload: 'none',
    muted: false,
    loop: false,
    autoplay: false,
  }));
  assert.equal(sourcePoster.statusCode, 400);
  assert.equal(await readFile(file, 'utf8'), source);

  const conflict = await send(middleware, JSON.stringify({
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Changed', 'markdown', 'p')),
    operation: 'insert-video-after',
    src: '/assets/safe.mp4',
    label: 'Safe video',
    description: 'A safe video that remains available after this conflict.',
    controls: true,
    preload: 'none',
    muted: false,
    loop: false,
    autoplay: false,
  }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(await readFile(file, 'utf8'), source);
  assert.deepEqual(await readFile(path.join(root, 'public/assets/safe.mp4')), TEST_MP4);
});

test('previews and replaces native videos without changing tracks, fallback content, or assets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-replace-'));
  const sourceRoot = path.join(root, 'src');
  const publicAssets = path.join(root, 'public/assets');
  await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(publicAssets, { recursive: true })]);
  const video = '<figure class="media">\n  <video controls preload="metadata" aria-label="Old tour" poster="/assets/old.png" muted loop playsinline>\n    <source src="/assets/old.mp4" type="video/mp4" />\n    <track kind="captions" src="/assets/tour.vtt" srclang="en" label="English" default />\n    <a href="/assets/old.mp4">Keep fallback text</a>.\n  </video>\n  <figcaption>Old visible description.</figcaption>\n</figure>';
  const files = ['video.astro', 'video.md', 'video.mdx'];
  await Promise.all([
    ...files.map((name) => writeFile(path.join(sourceRoot, name), `${video}\n`)),
    writeFile(path.join(publicAssets, 'old.mp4'), TEST_MP4),
    writeFile(path.join(publicAssets, 'new.mp4'), TEST_MP4),
    writeFile(path.join(publicAssets, 'old.png'), TEST_PNG),
    writeFile(path.join(publicAssets, 'new.png'), TEST_PNG),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, {}, [], sourceRoot);

  const preview = await send(middleware, '', undefined, {
    method: 'GET',
    url: '/_astro-wysiwyg/save/videos/preview?reference=%2Fassets%2Fnew.mp4',
  });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(JSON.parse(preview.body), { url: '/assets/new.mp4' });
  const previewMethod = await send(middleware, '', undefined, {
    method: 'POST', url: '/_astro-wysiwyg/save/videos/preview',
  });
  assert.equal(previewMethod.statusCode, 405);
  const missingReference = await send(middleware, '', undefined, {
    method: 'GET', url: '/_astro-wysiwyg/save/videos/preview',
  });
  assert.equal(missingReference.statusCode, 400);
  const oversizedPreview = await send(middleware, '', undefined, {
    method: 'GET', url: `/_astro-wysiwyg/save/videos/preview?reference=${'x'.repeat(2_001)}`,
  });
  assert.equal(oversizedPreview.statusCode, 413);

  for (const [name, format] of files.map((name) => [name, name.endsWith('.astro') ? 'astro' : 'markdown'] as const)) {
    const response = await send(middleware, JSON.stringify({
      operation: 'replace-video',
      marker: encodeMarker(createMarker(`src/${name}`, 0, video.length, video, format, 'figure')),
      src: '/assets/new.mp4',
      label: 'New tour',
      description: 'New visible description.',
      poster: '/assets/new.png',
      controls: true,
      preload: 'none',
      muted: true,
      loop: false,
      autoplay: true,
    }));
    assert.equal(response.statusCode, 200, `${name}: ${response.body}`);
    const saved = await readFile(path.join(sourceRoot, name), 'utf8');
    assert.match(saved, /source src="\/assets\/new\.mp4"/);
    assert.match(saved, /poster="\/assets\/new\.png"/);
    assert.match(saved, /track kind="captions" src="\/assets\/tour\.vtt"/);
    assert.match(saved, /<a href="\/assets\/new\.mp4">Keep fallback text<\/a>/);
  }
  assert.deepEqual(await readFile(path.join(publicAssets, 'old.mp4')), TEST_MP4);
  assert.deepEqual(await readFile(path.join(publicAssets, 'old.png')), TEST_PNG);
});

test('rejects unsafe or conflicting video replacements without changing source or assets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-replace-'));
  const sourceRoot = path.join(root, 'src');
  const publicAssets = path.join(root, 'public/assets');
  await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(publicAssets, { recursive: true })]);
  const video = '<figure><video controls preload="metadata" aria-label="Tour"><source src="/assets/old.mp4" type="video/mp4" /></video><figcaption>Tour description.</figcaption></figure>';
  const file = path.join(sourceRoot, 'video.md');
  await Promise.all([
    writeFile(file, `${video}\n`),
    writeFile(path.join(publicAssets, 'old.mp4'), TEST_MP4),
    writeFile(path.join(publicAssets, 'invalid.mp4'), testMp4('hvc1')),
    writeFile(path.join(sourceRoot, 'source-poster.png'), TEST_PNG),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, {}, [], sourceRoot);
  const body = {
    operation: 'replace-video',
    marker: encodeMarker(createMarker('src/video.md', 0, video.length, video, 'markdown', 'figure')),
    src: '/assets/invalid.mp4',
    label: 'New tour',
    description: 'New description.',
    controls: true,
    preload: 'metadata',
    muted: false,
    loop: false,
    autoplay: false,
  };
  const invalid = await send(middleware, JSON.stringify(body));
  assert.equal(invalid.statusCode, 400);
  const missing = await send(middleware, JSON.stringify({ ...body, src: '/assets/missing.mp4' }));
  assert.equal(missing.statusCode, 404);
  const sourcePoster = await send(middleware, JSON.stringify({
    ...body,
    src: '/assets/old.mp4',
    poster: 'source-poster.png',
  }));
  assert.equal(sourcePoster.statusCode, 400);
  const conflict = await send(middleware, JSON.stringify({
    ...body,
    src: '/assets/old.mp4',
    marker: encodeMarker(createMarker('src/video.md', 0, video.length, video.replace('Tour', 'Stale'), 'markdown', 'figure')),
  }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(await readFile(file, 'utf8'), `${video}\n`);
  assert.deepEqual(await readFile(path.join(publicAssets, 'old.mp4')), TEST_MP4);
});

test('previews, inserts, and updates approved native iframe embeds', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-iframe-'));
  const sourceRoot = path.join(root, 'src');
  await mkdir(sourceRoot, { recursive: true });
  const files = ['embed.astro', 'embed.md', 'embed.mdx'];
  await Promise.all(files.map((name) => writeFile(path.join(sourceRoot, name), name.endsWith('.astro') ? '<p>Before</p>\n' : 'Before\n')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, { iframeOrigins: ['self', 'https://player.example.com'] }, [], sourceRoot);

  const preview = await send(middleware, JSON.stringify({
    operation: 'insert-iframe-after', marker: '',
    src: '/embed-preview', title: 'Project status', width: 640, height: 360,
    loading: 'lazy', referrerPolicy: 'no-referrer', allow: [], sandbox: [], allowFullscreen: false,
  }), undefined, { url: '/_astro-wysiwyg/save/iframes/preview' });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(JSON.parse(preview.body), { src: '/embed-preview' });

  for (const name of files) {
    const astro = name.endsWith('.astro');
    const original = astro ? '<p>Before</p>' : 'Before';
    const format = astro ? 'astro' : 'markdown';
    const inserted = await send(middleware, JSON.stringify({
      operation: 'insert-iframe-after',
      marker: encodeMarker(createMarker(`src/${name}`, 0, original.length, original, format, 'p')),
      src: '/embed-preview', title: 'Local project status', width: 640, height: 360,
      loading: 'lazy', referrerPolicy: 'strict-origin-when-cross-origin',
      allow: ['fullscreen'], sandbox: ['allow-scripts'], allowFullscreen: true,
    }));
    assert.equal(inserted.statusCode, 200, `${name}: ${inserted.body}`);
    const insertedMarker = JSON.parse(inserted.body).marker as string;
    const updated = await send(middleware, JSON.stringify({
      operation: 'replace-iframe', marker: insertedMarker,
      src: 'https://player.example.com/embed/2', title: 'External project status', width: 800, height: 450,
      loading: 'eager', referrerPolicy: 'no-referrer',
      allow: [], sandbox: [], allowFullscreen: false,
    }));
    assert.equal(updated.statusCode, 200, `${name}: ${updated.body}`);
    assert.match(await readFile(path.join(sourceRoot, name), 'utf8'), /<iframe src="https:\/\/player\.example\.com\/embed\/2" title="External project status"/);
  }
});

test('rejects unapproved iframe previews, settings, and source conflicts without changes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-iframe-'));
  const sourceRoot = path.join(root, 'src');
  await mkdir(sourceRoot, { recursive: true });
  const iframe = '<iframe src="/embed-preview" title="Status" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>';
  const file = path.join(sourceRoot, 'embed.md');
  await writeFile(file, `${iframe}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, { iframeOrigins: ['self'] }, [], sourceRoot);
  const previewMethod = await send(middleware, '', undefined, {
    method: 'GET', url: '/_astro-wysiwyg/save/iframes/preview',
  });
  assert.equal(previewMethod.statusCode, 405);
  const incompletePreview = await send(middleware, '{}', undefined, {
    url: '/_astro-wysiwyg/save/iframes/preview',
  });
  assert.equal(incompletePreview.statusCode, 400);
  const unsafePreview = await send(middleware, JSON.stringify({
    operation: 'insert-iframe-after', marker: '',
    src: 'https://evil.example/embed', title: 'Unsafe', width: 640, height: 360,
    loading: 'lazy', referrerPolicy: 'no-referrer', allow: [], sandbox: [], allowFullscreen: false,
  }), undefined, { url: '/_astro-wysiwyg/save/iframes/preview' });
  assert.equal(unsafePreview.statusCode, 400);
  const base = {
    operation: 'replace-iframe',
    marker: encodeMarker(createMarker('src/embed.md', 0, iframe.length, iframe, 'markdown', 'iframe')),
    src: '/embed-preview', title: 'Status', width: 640, height: 360,
    loading: 'lazy', referrerPolicy: 'no-referrer', allow: [], sandbox: [], allowFullscreen: false,
  };
  const invalid = await send(middleware, JSON.stringify({ ...base, sandbox: ['allow-top-navigation'] }));
  assert.equal(invalid.statusCode, 400);
  const conflict = await send(middleware, JSON.stringify({
    ...base,
    marker: encodeMarker(createMarker('src/embed.md', 0, iframe.length, iframe.replace('Status', 'Stale'), 'markdown', 'iframe')),
  }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(await readFile(file, 'utf8'), `${iframe}\n`);
});

test('replaces Markdown, MDX, and Astro images with validated public or source assets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-replace-'));
  const sourceRoot = path.join(root, 'src');
  const pages = path.join(sourceRoot, 'pages');
  const assets = path.join(sourceRoot, 'assets');
  const publicAssets = path.join(root, 'public/assets');
  await Promise.all([
    mkdir(pages, { recursive: true }),
    mkdir(assets, { recursive: true }),
    mkdir(publicAssets, { recursive: true }),
  ]);
  const markdownSource = '[![Old](/assets/old.png "Title")](/docs) Caption\n';
  const mdxSource = '![Old](../assets/old.png)\n';
  const astroSource = '---\nimport photo from "../assets/old.png";\n---\n<p><img src={photo.src} alt="Old" width="20" /></p>\n';
  await Promise.all([
    writeFile(path.join(pages, 'images.md'), markdownSource),
    writeFile(path.join(pages, 'images.mdx'), mdxSource),
    writeFile(path.join(pages, 'images.astro'), astroSource),
    writeFile(path.join(publicAssets, 'old.png'), TEST_PNG),
    writeFile(path.join(publicAssets, 'new.png'), TEST_PNG),
    writeFile(path.join(assets, 'old.png'), TEST_PNG),
    writeFile(path.join(assets, 'new.png'), TEST_PNG),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, {}, [], sourceRoot);

  const markdown = await send(middleware, JSON.stringify({
    operation: 'replace-image',
    marker: encodeMarker(createMarker(
      'src/pages/images.md', 0, markdownSource.trimEnd().length,
      markdownSource.trimEnd(), 'markdown', 'p',
    )),
    src: '/assets/new.png',
    alt: 'New public image',
  }));
  assert.equal(markdown.statusCode, 200);
  assert.equal(
    await readFile(path.join(pages, 'images.md'), 'utf8'),
    '[![New public image](/assets/new.png "Title")](/docs) Caption\n',
  );

  const mdx = await send(middleware, JSON.stringify({
    operation: 'replace-image',
    marker: encodeMarker(createMarker(
      'src/pages/images.mdx', 0, mdxSource.trimEnd().length,
      mdxSource.trimEnd(), 'markdown', 'p',
    )),
    src: '../assets/new.png',
    alt: 'New source image',
  }));
  assert.equal(mdx.statusCode, 200);
  assert.equal(await readFile(path.join(pages, 'images.mdx'), 'utf8'), '![New source image](../assets/new.png)\n');

  const astroOriginal = '<p><img src={photo.src} alt="Old" width="20" /></p>';
  const astroStart = astroSource.indexOf(astroOriginal);
  const astro = await send(middleware, JSON.stringify({
    operation: 'replace-image',
    marker: encodeMarker(createMarker(
      'src/pages/images.astro', astroStart, astroStart + astroOriginal.length,
      astroOriginal, 'astro', 'p',
    )),
    src: '../assets/new.png',
    alt: 'New imported image',
  }));
  assert.equal(astro.statusCode, 200);
  assert.equal(
    await readFile(path.join(pages, 'images.astro'), 'utf8'),
    astroSource.replace('../assets/old.png', '../assets/new.png').replace('alt="Old"', 'alt="New imported image"'),
  );

  const marker = encodeMarker(createMarker(
    'src/pages/images.mdx', 0, mdxSource.trimEnd().length,
    mdxSource.trimEnd(), 'markdown', 'p',
  ));
  const preview = await send(middleware, '', {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'sec-fetch-site': 'same-origin',
  }, {
    method: 'GET',
    url: `/_astro-wysiwyg/save/assets/preview?marker=${encodeURIComponent(marker)}&reference=${encodeURIComponent('../assets/new.png')}`,
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.headers['Content-Type'], 'image/png');
  assert.deepEqual(Buffer.from(preview.body), TEST_PNG);
});

test('rejects invalid existing image replacements without changing source or assets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-replace-'));
  const sourceRoot = path.join(root, 'src');
  const page = path.join(sourceRoot, 'page.md');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(path.join(root, 'public/assets'), { recursive: true }),
  ]);
  const source = '![Old](/assets/old.png)\n';
  await Promise.all([
    writeFile(page, source),
    writeFile(path.join(root, 'public/assets/new.png'), TEST_PNG),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, {}, [], sourceRoot);
  const marker = encodeMarker(createMarker(
    'src/page.md', 0, source.trimEnd().length, source.trimEnd(), 'markdown', 'p',
  ));

  for (const replacement of ['/assets/missing.png', '../../outside.png', 'https://example.com/image.png']) {
    const response = await send(middleware, JSON.stringify({
      operation: 'replace-image', marker, src: replacement, alt: 'Replacement',
    }));
    assert.notEqual(response.statusCode, 200);
    assert.equal(await readFile(page, 'utf8'), source);
  }

  const conflict = await send(middleware, JSON.stringify({
    operation: 'replace-image',
    marker: encodeMarker(createMarker(
      'src/page.md', 0, source.trimEnd().length, '![Changed](/assets/old.png)', 'markdown', 'p',
    )),
    src: '/assets/new.png',
    alt: 'Replacement',
  }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(await readFile(page, 'utf8'), source);
  assert.deepEqual(await readFile(path.join(root, 'public/assets/new.png')), TEST_PNG);

  const previewPath = `/_astro-wysiwyg/save/assets/preview?marker=${encodeURIComponent(marker)}&reference=${encodeURIComponent('/assets/new.png')}`;
  const wrongMethod = await send(middleware, '', {
    host: 'localhost:4321', origin: 'http://localhost:4321',
    'content-type': 'application/json', 'sec-fetch-site': 'none',
  }, { url: previewPath });
  assert.equal(wrongMethod.statusCode, 405);
  const crossSitePreview = await send(middleware, '', {
    host: 'localhost:4321', 'sec-fetch-site': 'cross-site',
  }, { method: 'GET', url: previewPath });
  assert.equal(crossSitePreview.statusCode, 403);
  const oversizedPreview = await send(middleware, '', {
    host: 'localhost:4321', origin: 'http://localhost:4321',
  }, { method: 'GET', url: `/_astro-wysiwyg/save/assets/preview?marker=${'a'.repeat(20_001)}` });
  assert.equal(oversizedPreview.statusCode, 413);
  const malformedPreview = await send(middleware, '', {
    host: 'localhost:4321', origin: 'http://localhost:4321',
  }, { method: 'GET', url: '/_astro-wysiwyg/save/assets/preview?marker=bad&reference=%2Fassets%2Fnew.png' });
  assert.equal(malformedPreview.statusCode, 400);
  const missingMarker = await send(middleware, '', {
    host: 'localhost:4321', origin: 'http://localhost:4321',
  }, { method: 'GET', url: '/_astro-wysiwyg/save/assets/preview?reference=%2Fassets%2Fnew.png' });
  assert.equal(missingMarker.statusCode, 400);
});

test('rejects unsafe image uploads and leaves source and existing assets unchanged on partial failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-upload-'));
  const file = path.join(root, 'page.md');
  const source = 'Before\n';
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const png = TEST_PNG;
  const headers = {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'image/png',
    'x-astro-wysiwyg-filename': 'safe.png',
  };

  const missingName = await send(middleware, png, {
    host: headers.host,
    origin: headers.origin,
    'content-type': 'image/png',
  }, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(missingName.statusCode, 400);
  const missingType = await send(middleware, png, {
    host: headers.host,
    origin: headers.origin,
    'x-astro-wysiwyg-filename': 'missing-type.png',
  }, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(missingType.statusCode, 415);
  const empty = await send(middleware, Buffer.alloc(0), headers, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(empty.statusCode, 400);

  const first = await send(middleware, png, headers, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(first.statusCode, 201);
  const duplicate = await send(middleware, png, headers, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(duplicate.statusCode, 409);
  const traversal = await send(middleware, png, {
    ...headers,
    'x-astro-wysiwyg-filename': '../escape.png',
  }, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(traversal.statusCode, 400);
  const disguised = await send(middleware, Buffer.from('<svg><script /></svg>'), {
    ...headers,
    'x-astro-wysiwyg-filename': 'disguised.png',
  }, { url: '/_astro-wysiwyg/save/assets' });
  assert.equal(disguised.statusCode, 400);
  const oversized = await send(middleware, Buffer.alloc(5_000_001), headers, {
    url: '/_astro-wysiwyg/save/assets',
  });
  assert.equal(oversized.statusCode, 413);

  const staleMarker = encodeMarker(createMarker('page.md', 0, 6, 'Stale!', 'markdown', 'p'));
  const failedInsert = await send(middleware, JSON.stringify({
    marker: staleMarker,
    operation: 'insert-image-after',
    src: '/assets/safe.png',
    alt: 'Safe image',
  }));
  assert.equal(failedInsert.statusCode, 409);
  assert.equal(await readFile(file, 'utf8'), source);
  assert.deepEqual(await readFile(path.join(root, 'public/assets/safe.png')), png);
  await assert.rejects(readFile(path.join(root, 'escape.png')));
  await assert.rejects(readFile(path.join(root, 'public/assets/disguised.png')));
});

test('failed image asset writes leave source and existing public files unchanged', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-upload-'));
  const file = path.join(root, 'page.md');
  const blocked = path.join(root, 'public/blocked');
  await mkdir(path.dirname(blocked), { recursive: true });
  await writeFile(file, 'Before\n');
  await writeFile(blocked, 'keep');
  t.after(() => rm(root, { recursive: true, force: true }));
  const loggedErrors: unknown[] = [];
  const middleware = await saveMiddleware(root, { imageDirectory: 'blocked' }, loggedErrors);

  const response = await send(
    middleware,
    TEST_PNG,
    {
      host: 'localhost:4321',
      origin: 'http://localhost:4321',
      'content-type': 'image/png',
      'x-astro-wysiwyg-filename': 'image.png',
    },
    { url: '/_astro-wysiwyg/save/assets' },
  );

  assert.equal(response.statusCode, 500);
  assert.equal(await readFile(file, 'utf8'), 'Before\n');
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
  assert.equal(loggedErrors.length, 1);
});

test('save endpoint writes only inside the configured source directory', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const sourceRoot = path.join(root, 'src');
  const sourceFile = path.join(sourceRoot, 'page.md');
  const dependencyFile = path.join(root, 'node_modules/example/content.md');
  const linkedSourceFile = path.join(sourceRoot, 'linked.md');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(path.dirname(dependencyFile), { recursive: true }),
  ]);
  await writeFile(sourceFile, 'Source text\n');
  const dependencySource = '---\ntitle: Dependency\n---\nDependency text\n';
  await writeFile(dependencyFile, dependencySource);
  await symlink(dependencyFile, linkedSourceFile);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, {}, [], sourceRoot);

  const sourceResponse = await send(middleware, JSON.stringify({
    marker: encodeMarker(createMarker('src/page.md', 0, 11, 'Source text', 'markdown', 'p')),
    html: 'Updated source',
  }));
  assert.equal(sourceResponse.statusCode, 200);
  assert.equal(await readFile(sourceFile, 'utf8'), 'Updated source\n');

  const dependencyTextStart = dependencySource.indexOf('Dependency text');
  for (const file of ['node_modules/example/content.md', 'src/linked.md']) {
    const marker = encodeMarker(createMarker(
      file,
      dependencyTextStart,
      dependencyTextStart + 15,
      'Dependency text',
      'markdown',
      'p',
    ));
    const edit = await send(middleware, JSON.stringify({ marker, html: 'Changed dependency' }));
    assert.equal(edit.statusCode, 403, `${file} block edit`);
    const structure = await send(middleware, JSON.stringify({ marker, operation: 'delete' }));
    assert.equal(structure.statusCode, 403, `${file} structural edit`);
    const frontmatter = await send(middleware, JSON.stringify({
      frontmatter: 'update',
      contextMarker: marker,
      changes: { title: { value: 'Changed dependency', original: 'Dependency' } },
    }));
    assert.equal(frontmatter.statusCode, 403, `${file} frontmatter edit`);
  }
  assert.equal(await readFile(dependencyFile, 'utf8'), dependencySource);
});

test('save endpoint rejects a cross-origin request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const response = await send(middleware, '{}', {
    host: 'localhost:4321',
    origin: 'https://attacker.example',
    'content-type': 'application/json',
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /another origin/);
});

test('save endpoint rejects source writes from non-loopback clients', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.md');
  await writeFile(file, 'Old text\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const marker = encodeMarker(createMarker('page.md', 0, 8, 'Old text', 'markdown', 'p'));

  const response = await send(
    middleware,
    JSON.stringify({ marker, html: 'Remote edit', tag: 'p' }),
    undefined,
    { remoteAddress: '192.168.1.25' },
  );

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /local machine/);
  assert.equal(await readFile(file, 'utf8'), 'Old text\n');

  const missingAddress = await send(
    middleware,
    JSON.stringify({ marker, html: 'Unknown client', tag: 'p' }),
    undefined,
    { remoteAddress: null },
  );
  assert.equal(missingAddress.statusCode, 403);
  assert.equal(await readFile(file, 'utf8'), 'Old text\n');
});

test('save endpoint accepts IPv4-mapped and IPv6 loopback clients', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  for (const remoteAddress of ['::ffff:127.0.0.1', '::1']) {
    const response = await send(middleware, '{}', undefined, { remoteAddress });
    assert.equal(response.statusCode, 400, remoteAddress);
    assert.match(response.body, /incomplete/, remoteAddress);
  }
});

test('save endpoint rejects a non-JSON request', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const response = await send(middleware, 'text', {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'text/plain',
  });

  assert.equal(response.statusCode, 415);
  assert.match(response.body, /must contain JSON/);
});

test('save endpoint rejects oversized JSON before parsing it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const response = await send(middleware, `{"html":"${'x'.repeat(1_100_000)}"}`);

  assert.equal(response.statusCode, 413);
  assert.match(response.body, /too large/);
});

test('reuses a configured unified Markdown processor', async () => {
  const integration = wysiwyg();
  const rehypePlugins: unknown[] = [];
  const remarkPlugins: unknown[] = [];
  const processor = { name: 'unified', options: { remarkPlugins, rehypePlugins } };
  let update: unknown;
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: {
      root: new URL('file:///project/'),
      srcDir: new URL('file:///project/src/'),
      markdown: { processor },
    },
    updateConfig: (value: unknown) => { update = value; return value; },
    injectScript: () => undefined,
    addDevToolbarApp: () => undefined,
  } as never);

  assert.equal(rehypePlugins.length, 1);
  assert.equal(remarkPlugins.length, 1);
  const configured = update as {
    markdown: { processor: unknown };
    vite: {
      plugins: Array<{
        name: string;
        enforce?: string;
        transform?: {
          handler(source: string, id: string): Promise<{ code: string; map: null } | undefined>;
        };
      }>;
    };
  };
  assert.equal(configured.markdown.processor, processor);
  assert.deepEqual(
    configured.vite.plugins.map(({ name, enforce }) => ({ name, enforce })),
    [
      { name: 'astro-wysiwyg:source-annotations', enforce: 'pre' },
      { name: 'astro-wysiwyg:quiet-editor-writes', enforce: 'pre' },
    ],
  );
  const annotation = configured.vite.plugins[0].transform;
  assert.ok(annotation);
  assert.equal(await annotation.handler('export default 1', '/project/example.ts'), undefined);
  assert.equal(
    await annotation.handler('<p>Style request</p>', '/project/page.astro?astro&type=style'),
    undefined,
  );
  assert.equal(await annotation.handler('<Component />', '/project/page.astro'), undefined);
  assert.match(
    (await annotation.handler('<p>Annotated</p>', '/project/page.astro'))?.code ?? '',
    /data-astro-source-file/,
  );
});

test('uses a unified development processor when Astro provides Satteri', async () => {
  const integration = wysiwyg();
  let update: unknown;
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: {
      root: new URL('file:///project/'),
      srcDir: new URL('file:///project/src/'),
      markdown: { processor: { name: 'satteri', options: {} } },
    },
    updateConfig: (value: unknown) => { update = value; return value; },
    injectScript: () => undefined,
    addDevToolbarApp: () => undefined,
  } as never);

  const configured = update as {
    markdown: {
      processor: { name: string; options: { remarkPlugins: unknown[]; rehypePlugins: unknown[] } };
    };
  };
  assert.equal(configured.markdown.processor.name, 'unified');
  assert.equal(configured.markdown.processor.options.remarkPlugins.length, 1);
  assert.equal(configured.markdown.processor.options.rehypePlugins.length, 1);
});

test('falls back when a configured Markdown processor cannot accept rehype plugins', async () => {
  for (const processor of [
    { name: 'other' },
    { name: 'unified' },
    { name: 'unified', options: { rehypePlugins: 'invalid' } },
  ]) {
    const integration = wysiwyg();
    let update: unknown;
    await integration.hooks['astro:config:setup']?.({
      command: 'dev',
      config: {
        root: new URL('file:///project/'),
        srcDir: new URL('file:///project/src/'),
        markdown: { processor },
      },
      updateConfig: (value: unknown) => { update = value; return value; },
      injectScript: () => undefined,
      addDevToolbarApp: () => undefined,
    } as never);
    assert.match(JSON.stringify(update), /rehypePlugins/);
    assert.match(JSON.stringify(update), /remarkPlugins/);
  }
});

test('validates and normalizes custom endpoint paths', async (t) => {
  assert.throws(() => wysiwyg({ endpoint: 'relative' }), /absolute URL path/);
  assert.throws(() => wysiwyg({ imageDirectory: '../outside' }), /asset directory/i);
  assert.throws(() => wysiwyg({ endpoint: '/save?query' }), /absolute URL path/);
  assert.throws(() => wysiwyg({ endpoint: '/save#hash' }), /absolute URL path/);
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, { endpoint: '/custom/' });
  const response = await send(middleware, '{}', undefined, { url: '/custom' });
  assert.equal(response.statusCode, 400);
});

test('server setup is inert until development configuration runs', async () => {
  const integration = wysiwyg();
  let registered = false;
  await integration.hooks['astro:server:setup']?.({
    server: { middlewares: { use: () => { registered = true; } } },
  } as never);
  assert.equal(registered, false);
});

test('save middleware passes unrelated paths through and rejects other methods', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const unrelated = await send(middleware, '{}', undefined, { url: '/other' });
  assert.equal(unrelated.body, 'next');
  const method = await send(middleware, '{}', undefined, { method: 'GET' });
  assert.equal(method.statusCode, 405);
});

test('save endpoint accepts requests without Origin and rejects malformed Origin', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const withoutOrigin = await send(middleware, '{}', {
    host: 'localhost:4321',
    'content-type': 'application/json',
  });
  assert.equal(withoutOrigin.statusCode, 400);
  const malformed = await send(middleware, '{}', {
    host: 'localhost:4321',
    origin: 'not a URL',
    'content-type': 'application/json',
  });
  assert.equal(malformed.statusCode, 403);
});

test('save endpoint discovers writable collections and creates one guarded entry', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-collection-endpoint-'));
  const sourceRoot = path.join(root, 'src');
  await mkdir(path.join(sourceRoot, 'content/articles/existing'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'pages/articles'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'content.config.ts'), `
    const articles = defineCollection({
      loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/articles' }),
      schema: z.object({ title: z.string(), description: z.string(), published: z.boolean().optional() }),
    });
    const remote = defineCollection({ loader: remoteLoader(), schema: z.object({ title: z.string() }) });
    export const collections = { articles, remote };
  `);
  await writeFile(path.join(sourceRoot, 'content/articles/existing/index.md'), '---\ntitle: Existing\ndescription: Existing\n---\n');
  await writeFile(path.join(sourceRoot, 'pages/articles/[slug].astro'), "export const prerender = false; const entries = await getCollection('articles');");
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, {}, [], sourceRoot);

  const discovery = await send(middleware, JSON.stringify({ collections: 'discover' }));
  assert.equal(discovery.statusCode, 200);
  const discovered = JSON.parse(String(discovery.body));
  assert.deepEqual(discovered.collections.map(({ name }: { name: string }) => name), ['articles']);
  assert.match(discovered.unsupported[0].reason, /loader-backed/i);

  const created = await send(middleware, JSON.stringify({
    collections: 'create',
    collection: 'articles',
    slug: 'new-entry',
    values: { title: 'New entry', description: 'Created in the editor', published: true },
    body: 'Starter content.',
  }));
  assert.equal(created.statusCode, 201);
  assert.deepEqual(JSON.parse(String(created.body)), {
    created: true,
    collection: 'articles',
    slug: 'new-entry',
    file: 'src/content/articles/new-entry/index.md',
    route: '/articles/new-entry/',
  });
  assert.match(await readFile(path.join(sourceRoot, 'content/articles/new-entry/index.md'), 'utf8'), /title: "New entry"/);

  const duplicate = await send(middleware, JSON.stringify({
    collections: 'create', collection: 'articles', slug: 'new-entry',
    values: { title: 'Duplicate', description: 'No overwrite' }, body: 'Duplicate.',
  }));
  assert.equal(duplicate.statusCode, 409);
  assert.match(String(duplicate.body), /already exists/i);
  assert.doesNotMatch(await readFile(path.join(sourceRoot, 'content/articles/new-entry/index.md'), 'utf8'), /Duplicate/);
});

test('save endpoint rejects malformed collection creation without side effects', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-collection-endpoint-'));
  const sourceRoot = path.join(root, 'src');
  await mkdir(path.join(sourceRoot, 'content/articles'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'content.config.ts'), `
    const articles = defineCollection({
      loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
      schema: z.object({ title: z.string() }),
    });
    export const collections = { articles };
  `);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, {}, [], sourceRoot);

  for (const body of [
    { collections: 'create' },
    { collections: 'create', collection: 'articles', slug: '../escape', values: { title: 'Unsafe' }, body: 'Body' },
    { collections: 'create', collection: 'articles', slug: 'missing-title', values: {}, body: 'Body' },
    { collections: 'create', collection: 'remote', slug: 'remote', values: { title: 'Remote' }, body: 'Body' },
  ]) {
    const response = await send(middleware, JSON.stringify(body));
    assert.equal(response.statusCode, 400, String(response.body));
  }
  assert.deepEqual(await readdir(path.join(sourceRoot, 'content/articles')), []);
});

test('save endpoint reads and updates frontmatter', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.md');
  const source = '---\ntitle: Old\nenabled: false\n---\nBody\n';
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const marker = encodeMarker(createMarker('page.md', 0, 0, '', 'markdown', 'p'));

  const read = await send(middleware, JSON.stringify({ frontmatter: 'read', contextMarker: marker }));
  assert.equal(read.statusCode, 200);
  const fields = (JSON.parse(read.body) as {
    fields: Array<{ name: string; original: string }>;
  }).fields;
  assert.equal(fields.find((field) => field.name === 'title')?.original, 'Old');
  const update = await send(middleware, JSON.stringify({
    frontmatter: 'update',
    contextMarker: marker,
    changes: {
      title: { value: 'New', original: 'Old' },
      enabled: { value: true, original: 'false' },
    },
  }));
  assert.equal(update.statusCode, 200);
  assert.match(await readFile(file, 'utf8'), /title: New\nenabled: true/);

  const conflict = await send(middleware, JSON.stringify({
    frontmatter: 'update',
    contextMarker: marker,
    changes: { title: { value: 'Overwrite', original: 'Old' } },
  }));
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.body, /title frontmatter field changed on disk/);
  assert.match(await readFile(file, 'utf8'), /title: New\nenabled: true/);
});

test('save endpoint returns actionable frontmatter value validation errors', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.md');
  const source = '---\npublishedAt: 2026-06-24\npublishedHour: 14\n---\nBody\n';
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const loggedErrors: unknown[] = [];
  const middleware = await saveMiddleware(root, {}, loggedErrors);
  const marker = encodeMarker(createMarker('page.md', 0, 0, '', 'markdown', 'p'));

  for (const [name, value, original, message] of [
    ['publishedHour', 'afternoon', '14', 'publishedHour must be a number.'],
    ['publishedAt', 'June 24', '2026-06-24', 'publishedAt must use YYYY-MM-DD.'],
  ] as const) {
    const response = await send(middleware, JSON.stringify({
      frontmatter: 'update',
      contextMarker: marker,
      changes: { [name]: { value, original } },
    }));
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), { error: message });
  }
  assert.deepEqual(loggedErrors, []);
  assert.equal(await readFile(file, 'utf8'), source);
});

test('save endpoint inserts and replaces registered static content blocks atomically', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-content-block-'));
  const file = path.join(root, 'page.md');
  await writeFile(file, 'Before\nAfter\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const marker = encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p'));
  const inserted = await send(middleware, JSON.stringify({
    marker, operation: 'insert-content-after', type: 'blockquote',
    value: { text: 'A safe quote', items: [] },
  }));
  assert.equal(inserted.statusCode, 200);
  assert.equal(await readFile(file, 'utf8'), 'Before\n\n> A safe quote\nAfter\n');
  const insertedMarker = (JSON.parse(inserted.body) as { marker: string }).marker;
  const warning = await send(middleware, JSON.stringify({
    marker: insertedMarker, operation: 'replace-content', type: 'divider',
    value: { text: 'A safe quote', items: [] },
  }));
  assert.equal(warning.statusCode, 409);
  assert.match(warning.body, /removes all content/i);
  const replaced = await send(middleware, JSON.stringify({
    marker: insertedMarker, operation: 'replace-content', type: 'divider',
    value: { text: 'A safe quote', items: [] }, confirmedLoss: true,
  }));
  assert.equal(replaced.statusCode, 200);
  assert.equal(await readFile(file, 'utf8'), 'Before\n\n---\nAfter\n');
});

test('save endpoint resolves Astro markers and applies structural edits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.astro');
  await writeFile(file, '<p>Old</p>\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const resolved = await send(middleware, JSON.stringify({
    sourceFile: file,
    sourceLocation: '1:2',
  }));
  assert.equal(resolved.statusCode, 200);
  const marker = (JSON.parse(resolved.body) as { marker: string }).marker;
  const inserted = await send(middleware, JSON.stringify({ marker, operation: 'insert-after' }));
  assert.equal(inserted.statusCode, 200);
  assert.equal(await readFile(file, 'utf8'), '<p>Old</p>\n<p>New paragraph</p>\n');
  const insertedMarker = (JSON.parse(inserted.body) as { marker: string }).marker;
  const deleted = await send(middleware, JSON.stringify({ marker: insertedMarker, operation: 'delete' }));
  assert.equal(deleted.statusCode, 200);
  assert.equal(await readFile(file, 'utf8'), '<p>Old</p>\n');
});

test('save endpoint returns 400 instead of 500 for non-editable Astro source', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.astro');
  await writeFile(file, '<p>{dynamic}</p>\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const resolved = await send(middleware, JSON.stringify({
    sourceFile: file,
    sourceLocation: '1:2',
  }));
  assert.equal(resolved.statusCode, 400);
  assert.match(resolved.body, /not a static editable block/);
});

test('save endpoint rejects malformed, incomplete, and oversized edit payloads', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);

  const malformed = await send(middleware, Buffer.from('{'));
  assert.equal(malformed.statusCode, 400);
  assert.match(malformed.body, /invalid JSON/);
  const incomplete = await send(middleware, JSON.stringify({ marker: 'token' }));
  assert.equal(incomplete.statusCode, 400);
  const oversized = await send(middleware, JSON.stringify({ marker: 'token', html: 'x'.repeat(1_000_001) }));
  assert.equal(oversized.statusCode, 413);
});

test('save endpoint rejects every malformed request shape', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const malformed = [
    'null',
    '[]',
    JSON.stringify({ frontmatter: 'read' }),
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token' }),
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token', changes: [] }),
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token', changes: { field: 1 } }),
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token', changes: { field: [] } }),
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token', changes: { field: { value: 'next' } } }),
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token', changes: {
      field: { value: 1, original: 'old' },
    } }),
    JSON.stringify({ sourceFile: 1, sourceLocation: '1:1' }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: 1 }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: '1:1', contextMarker: 1 }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: '1:1', contextHref: 1 }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: '1:1', renderedText: 1 }),
    JSON.stringify({ marker: 1, operation: 'delete' }),
    JSON.stringify({ marker: 'token', operation: 'insert-content-after', type: 'unknown' }),
    JSON.stringify({ marker: 'token', operation: 'replace-content', type: 'paragraph', value: [] }),
    JSON.stringify({ marker: 'token', operation: 'replace-content', type: 'paragraph', value: { text: 1, items: [] } }),
    JSON.stringify({ marker: 'token', operation: 'replace-content', type: 'paragraph', value: { text: 'x', items: [1] } }),
    JSON.stringify({ marker: 'token', operation: 'replace-content', type: 'paragraph', confirmedLoss: 'yes' }),
    JSON.stringify({ marker: 'token', operation: 'replace-content', type: 'heading', headingLevel: '2' }),
    JSON.stringify({ marker: 'token', operation: 'replace-content', type: 'code-block', codeLanguage: 1 }),
    JSON.stringify({ marker: 'token', operation: 'replace-content', type: 'paragraph', html: 1 }),
    JSON.stringify({ marker: 'token', operation: 'invalid' }),
    JSON.stringify({ marker: 1, html: 'text' }),
    JSON.stringify({ marker: 'token', html: 1 }),
    JSON.stringify({ marker: 'token', html: 'text', text: 1 }),
    JSON.stringify({ marker: 'token', html: 'text', tag: 1 }),
  ];
  for (const body of malformed) {
    const response = await send(middleware, body);
    assert.equal(response.statusCode, 400, body);
  }
  const missingUrl = await send(middleware, '{}', undefined, { url: null });
  assert.equal(missingUrl.body, 'next');
});

test('supports the root endpoint without trailing-slash normalization', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root, { endpoint: '/' });
  const response = await send(middleware, '{}', undefined, { url: '/' });
  assert.equal(response.statusCode, 400);
});

test('save endpoint redacts unexpected source errors from responses', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loggedErrors: unknown[] = [];
  const middleware = await saveMiddleware(root, {}, loggedErrors);
  const missingFile = path.join(root, 'missing.astro');

  const response = await send(middleware, JSON.stringify({
    sourceFile: missingFile,
    sourceLocation: '1:1',
  }));

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'The editor request could not be completed.' });
  assert.equal(response.body.includes(root), false);
  assert.equal(loggedErrors.length, 1);
  assert.match(String(loggedErrors[0]), new RegExp(missingFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('does not register editor code for build', async () => {
  const integration = wysiwyg();
  let updated = false;
  let injected = false;
  await integration.hooks['astro:config:setup']?.({
    command: 'build',
    config: { root: new URL('file:///project/') },
    updateConfig: () => { updated = true; return {}; },
    injectScript: () => { injected = true; },
  } as never);

  assert.equal(updated, false);
  assert.equal(injected, false);
});
