import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import wysiwyg from '../src/index.ts';
import { createMarker, encodeMarker } from '../src/marker.ts';

type Middleware = (
  request: Readable & { method?: string; url?: string; headers: Record<string, string> },
  response: TestResponse,
  next: () => void,
) => void | Promise<void>;

interface TestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

async function saveMiddleware(
  root: string,
  options: Parameters<typeof wysiwyg>[0] = {},
): Promise<Middleware> {
  const integration = wysiwyg(options);
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: { root: pathToFileURL(`${root}${path.sep}`), markdown: {} },
    updateConfig: (value: unknown) => value,
    injectScript: () => undefined,
    addDevToolbarApp: () => undefined,
  } as never);
  let middleware: Middleware | undefined;
  await integration.hooks['astro:server:setup']?.({
    server: { middlewares: { use: (handler: Middleware) => { middleware = handler; } } },
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
  requestOptions: { method?: string; url?: string | null } = {},
): Promise<TestResponse> {
  const request = Object.assign(Readable.from([body]), {
    method: requestOptions.method ?? 'POST',
    url: requestOptions.url === null ? undefined : (requestOptions.url ?? '/_astro-wysiwyg/save'),
    headers,
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
    config: { root: new URL('file:///project/') },
    updateConfig: (value: unknown) => { updates.push(value); return value; },
    injectScript: (stage: string, content: string) => scripts.push([stage, content]),
    addDevToolbarApp: (app: unknown) => toolbarApps.push(app),
  } as never);

  assert.equal(integration.name, 'astro-wysiwyg');
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0]), /rehypePlugins/);
  assert.deepEqual(scripts.map(([stage]) => stage), ['page']);
  assert.match(scripts[0][1], /startEditor/);
  assert.equal(toolbarApps.length, 1);
  assert.match(JSON.stringify(toolbarApps[0]), /astro-wysiwyg/);
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
  const processor = { name: 'unified', options: { rehypePlugins } };
  let update: unknown;
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: { root: new URL('file:///project/'), markdown: { processor } },
    updateConfig: (value: unknown) => { update = value; return value; },
    injectScript: () => undefined,
    addDevToolbarApp: () => undefined,
  } as never);

  assert.equal(rehypePlugins.length, 1);
  assert.deepEqual(update, { markdown: { processor } });
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
      config: { root: new URL('file:///project/'), markdown: { processor } },
      updateConfig: (value: unknown) => { update = value; return value; },
      injectScript: () => undefined,
      addDevToolbarApp: () => undefined,
    } as never);
    assert.match(JSON.stringify(update), /rehypePlugins/);
  }
});

test('validates and normalizes custom endpoint paths', async (t) => {
  assert.throws(() => wysiwyg({ endpoint: 'relative' }), /absolute URL path/);
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
  assert.match(read.body, /"title"/);
  const update = await send(middleware, JSON.stringify({
    frontmatter: 'update',
    contextMarker: marker,
    values: { title: 'New', enabled: true },
  }));
  assert.equal(update.statusCode, 200);
  assert.match(await readFile(file, 'utf8'), /title: New\nenabled: true/);
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
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token', values: [] }),
    JSON.stringify({ frontmatter: 'update', contextMarker: 'token', values: { field: 1 } }),
    JSON.stringify({ sourceFile: 1, sourceLocation: '1:1' }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: 1 }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: '1:1', contextMarker: 1 }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: '1:1', contextHref: 1 }),
    JSON.stringify({ sourceFile: 'page.astro', sourceLocation: '1:1', renderedText: 1 }),
    JSON.stringify({ marker: 1, operation: 'delete' }),
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

test('save endpoint maps unexpected source errors to server errors', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-endpoint-'));
  const file = path.join(root, 'page.md');
  await writeFile(file, 'Body without frontmatter\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = await saveMiddleware(root);
  const marker = encodeMarker(createMarker('page.md', 0, 0, '', 'markdown', 'p'));

  const response = await send(middleware, JSON.stringify({ frontmatter: 'read', contextMarker: marker }));
  assert.equal(response.statusCode, 500);
  assert.match(response.body, /no frontmatter/);
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
