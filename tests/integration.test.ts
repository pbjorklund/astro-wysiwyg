import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import wysiwyg from '../src/index.ts';
import { createMarker, encodeMarker } from '../src/marker.ts';

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
  body: string;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

async function saveMiddleware(
  root: string,
  options: Parameters<typeof wysiwyg>[0] = {},
  loggedErrors: unknown[] = [],
  sourceRoot = root,
  configuredValues: unknown[] = [],
): Promise<Middleware> {
  const integration = wysiwyg(options);
  await integration.hooks['astro:config:setup']?.({
    command: 'dev',
    config: {
      root: pathToFileURL(`${root}${path.sep}`),
      srcDir: pathToFileURL(`${sourceRoot}${path.sep}`),
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
  assert.equal(await filter.handleHotUpdate({
    file,
    read: () => readFile(file, 'utf8'),
  }), undefined);

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
  const processor = { name: 'unified', options: { rehypePlugins } };
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
  const configured = update as {
    markdown: { processor: unknown };
    vite: { plugins: Array<{ name: string; enforce?: string }> };
  };
  assert.equal(configured.markdown.processor, processor);
  assert.deepEqual(
    configured.vite.plugins.map(({ name, enforce }) => ({ name, enforce })),
    [{ name: 'astro-wysiwyg:quiet-editor-writes', enforce: 'pre' }],
  );
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
