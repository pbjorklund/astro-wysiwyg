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

async function saveMiddleware(root: string): Promise<Middleware> {
  const integration = wysiwyg();
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
  body: string,
  headers: Record<string, string> = {
    host: 'localhost:4321',
    origin: 'http://localhost:4321',
    'content-type': 'application/json',
  },
): Promise<TestResponse> {
  const request = Object.assign(Readable.from([body]), {
    method: 'POST',
    url: '/_astro-wysiwyg/save',
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
    Promise.resolve(middleware(request, response, () => reject(new Error('Unexpected next middleware'))))
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
