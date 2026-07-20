import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CollectionEntryError,
  createContentCollectionEntry,
  discoverContentCollections,
} from '../src/collection-entries.ts';

async function projectFixture(config: string): Promise<{ root: string; sourceRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-collections-'));
  const sourceRoot = path.join(root, 'src');
  await mkdir(path.join(sourceRoot, 'content'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'content.config.ts'), config);
  return { root, sourceRoot };
}

const config = `
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
const articles = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    published: z.boolean().default(false),
    score: z.number().optional(),
    launchDate: z.coerce.date().optional(),
    tags: z.array(z.string()).optional(),
  }),
});
const remote = defineCollection({ loader: remoteLoader(), schema: z.object({ title: z.string() }) });
const unsafe = defineCollection({ loader: glob({ pattern: '**/*.md', base: '../outside' }), schema: z.object({ title: z.string() }) });
const unsupported = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/unsupported' }),
  schema: z.object({ title: z.enum(['one', 'two']) }),
});
export const collections = { articles, remote, unsafe, unsupported };
`;

test('discovers only writable local glob collections and explains unsupported definitions', async (t) => {
  const fixture = await projectFixture(config);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sourceRoot, 'content/articles/example'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'content/articles/example/index.md'), '---\ntitle: Example\n---\n');
  await mkdir(path.join(fixture.sourceRoot, 'pages/articles'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'pages/articles/[slug].astro'), "export const prerender = false; const entries = await getCollection('articles');");

  const result = await discoverContentCollections(fixture.root, fixture.sourceRoot);
  assert.deepEqual(result.writable.map(({ name }) => name), ['articles']);
  assert.deepEqual(result.writable[0], {
    name: 'articles',
    directory: 'src/content/articles',
    extension: '.md',
    entryStyle: 'index',
    routePattern: '/articles/{slug}/',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'description', type: 'string', required: true },
      { name: 'published', type: 'boolean', required: false, defaultValue: false },
      { name: 'score', type: 'number', required: false },
      { name: 'launchDate', type: 'date', required: false },
      { name: 'tags', type: 'list', required: false },
    ],
  });
  assert.deepEqual(result.unsupported.map(({ name }) => name), ['remote', 'unsafe', 'unsupported']);
  assert.match(result.unsupported[0].reason, /loader-backed|local glob/i);
  assert.match(result.unsupported[1].reason, /content directory|outside/i);
  assert.match(result.unsupported[2].reason, /title.*unsupported/i);
});

test('creates one schema-valid entry with collection naming, frontmatter, body, and route guidance', async (t) => {
  const fixture = await projectFixture(config);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sourceRoot, 'content/articles/example'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'content/articles/example/index.md'), '---\ntitle: Example\n---\n');
  await mkdir(path.join(fixture.sourceRoot, 'pages/articles'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'pages/articles/[slug].astro'), "export const prerender = false; const entries = await getCollection('articles');");

  const writes: Array<{ file: string; source: string }> = [];
  const result = await createContentCollectionEntry(fixture.root, fixture.sourceRoot, {
    collection: 'articles',
    slug: 'release-notes',
    values: {
      title: 'Release notes: July',
      description: 'A safe # summary',
      published: true,
      score: '4.5',
      launchDate: '2026-07-21',
      tags: 'release, editor',
    },
    body: 'Start writing the release notes here.',
  }, (file, source) => { writes.push({ file, source }); });

  assert.deepEqual(result, {
    collection: 'articles',
    slug: 'release-notes',
    file: 'src/content/articles/release-notes/index.md',
    route: '/articles/release-notes/',
  });
  const source = await readFile(path.join(fixture.root, result.file), 'utf8');
  assert.equal(source, `---\ntitle: "Release notes: July"\ndescription: "A safe # summary"\npublished: true\nscore: 4.5\nlaunchDate: 2026-07-21\ntags: ["release","editor"]\n---\n\nStart writing the release notes here.\n`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source, source);
});

test('rejects unsafe names, invalid fields, collisions, and concurrent creates before overwriting', async (t) => {
  const fixture = await projectFixture(config);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sourceRoot, 'content/articles'), { recursive: true });
  const base = {
    collection: 'articles',
    slug: 'safe-entry',
    values: { title: 'Safe title', description: 'Description' },
    body: 'Starter body.',
  };

  for (const slug of ['', '../escape', 'UPPER', 'two words', '.hidden', 'a'.repeat(101)]) {
    await assert.rejects(
      createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...base, slug }),
      (error: unknown) => error instanceof CollectionEntryError && error.status === 400 && /slug|filename/i.test(error.message),
    );
  }
  for (const [values, message] of [
    [{ description: 'Description' }, /title.*required/i],
    [{ title: 'Safe', description: 'Description', score: 'many' }, /score.*number/i],
    [{ title: 'Safe', description: 'Description', launchDate: '2026-02-31' }, /launchDate.*date/i],
    [{ title: 'Safe', description: 'Description', tags: 'valid, ,item' }, /tags/i],
  ] as const) {
    await assert.rejects(
      createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...base, values: values as Record<string, string> }),
      message,
    );
  }
  await assert.rejects(
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...base, values: { ...base.values, unknown: 'value' } }),
    /unknown.*field/i,
  );
  await assert.rejects(
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...base, body: '' }),
    /starter body/i,
  );

  const attempts = await Promise.allSettled([
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, base),
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, base),
  ]);
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejection = attempts.find(({ status }) => status === 'rejected');
  assert.ok(rejection?.status === 'rejected' && rejection.reason instanceof CollectionEntryError);
  assert.equal(rejection.reason.status, 409);
  assert.match(rejection.reason.message, /already exists/i);
  assert.match(await readFile(path.join(fixture.sourceRoot, 'content/articles/safe-entry.md'), 'utf8'), /Safe title/);
});

test('rejects cross-extension slug collisions and removes an empty entry directory after write failure', async (t) => {
  const fixture = await projectFixture(config);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sourceRoot, 'content/articles/example'), { recursive: true });
  await mkdir(path.join(fixture.sourceRoot, 'content/articles/collision'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'content/articles/example/index.md'), '---\ntitle: Example\n---\n');
  await writeFile(path.join(fixture.sourceRoot, 'content/articles/collision/index.mdx'), '---\ntitle: Existing MDX\n---\n');
  const request = {
    collection: 'articles', values: { title: 'Title', description: 'Description' }, body: 'Body.',
  };
  await assert.rejects(
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...request, slug: 'collision' }),
    (error: unknown) => error instanceof CollectionEntryError && error.status === 409,
  );
  await assert.rejects(
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...request, slug: 'failed-write' }, () => {
      throw new Error('Expected write hook failure');
    }),
    /Expected write hook failure/,
  );
  await assert.rejects(access(path.join(fixture.sourceRoot, 'content/articles/failed-write')));
});

test('ignores commented and quoted collection declarations during static discovery', async (t) => {
  const fixture = await projectFixture(`
    const decoy = "export const collections = { fake };";
    /* const fake = defineCollection({ loader: glob({ pattern: 'fake.md', base: './src/content/fake' }), schema: z.object({ title: z.string() }) }); */
    // export const collections = { fake };
    const articles = defineCollection({
      // Local loader comment.
      loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
      /* Static schema comment. */
      schema: z.object({ title: z.string() }),
    });
    export const collections = { articles }; // final comment
  `.trimEnd());
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const discovery = await discoverContentCollections(fixture.root, fixture.sourceRoot);
  assert.deepEqual(discovery.writable.map(({ name }) => name), ['articles']);
});

test('discovers prospective directories without writing and rejects unsafe exported collection names', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-prospective-'));
  const sourceRoot = path.join(root, 'src');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, 'content.config.ts'), `
    const articles = defineCollection({
      loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
      schema: z.object({ title: z.string() }),
    });
    export const collections = { articles, '../escape': articles };
  `);
  t.after(() => rm(root, { recursive: true, force: true }));
  const discovery = await discoverContentCollections(root, sourceRoot);
  assert.deepEqual(discovery.writable.map(({ name }) => name), ['articles']);
  assert.match(discovery.unsupported.find(({ name }) => name === '../escape')?.reason ?? '', /name/i);
  await assert.rejects(access(path.join(sourceRoot, 'content')));
});

test('reports unsupported config shapes and keeps optional unsupported fields visible', async (t) => {
  const cases: Array<[string, RegExp]> = [
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ title: z.string() }) });`, /does not export/i],
    [`export const collections = { missing };`, /dynamic|inspected/i],
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ title: z.string() }) }); export const collections = { articles: createCollection() };`, /does not export/i],
    [`const articles = defineCollection({ loader: glob({ pattern: patternName, base: './src/content/articles' }), schema: z.object({ title: z.string() }) }); export const collections = { articles };`, /literal base and pattern/i],
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.json', base: './src/content/articles' }), schema: z.object({ title: z.string() }) }); export const collections = { articles };`, /Markdown or MDX/i],
    [`const articles = defineCollection({ [loaderName]: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ title: z.string() }) }); export const collections = { articles };`, /loader-backed|local glob/i],
    [`const articles = defineCollection({ loader: glob({ pattern: "**/*.md", base: "\\x2e/src/content/articles" }), schema: z.object({ title: z.string() }) }); export const collections = { articles };`, /literal base and pattern/i],
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }) }); export const collections = { articles };`, /static z\.object/i],
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ 'bad name': z.string() }) }); export const collections = { articles };`, /unsupported name/i],
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({}) }); export const collections = { articles };`, /no supported fields/i],
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ ...shared, title: z.string() }) }); export const collections = { articles };`, /static|dynamic|unsupported/i],
    [`const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: \`./src/content/\${directory}\` }), schema: z.object({ title: z.string() }) }); export const collections = { articles };`, /literal base and pattern/i],
  ];
  for (const [source, reason] of cases) {
    const fixture = await projectFixture(source);
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const discovery = await discoverContentCollections(fixture.root, fixture.sourceRoot);
    assert.equal(discovery.writable.length, 0, source);
    assert.match(discovery.unsupported[0].reason, reason);
  }

  const fixture = await projectFixture(`
    const articles = defineCollection({
      loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
      schema: z.object({
        title: z.string(),
        category: z.enum(['one']).optional(),
        invalidDefault: z.string().default(false),
        invalidListDefault: z.array(z.string()).default('bad'),
        dynamicDefault: z.string().default(dynamicDefault),
        rating: z.number().default(3),
        label: z.string().default('New label'),
        releaseDate: z.coerce.date().default('2026-07-21'),
        escapedLabel: z.string().default('New \\'label'),
      }),
    });
    export const collections = { articles };
  `);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const discovery = await discoverContentCollections(fixture.root, fixture.sourceRoot);
  assert.deepEqual(discovery.writable[0].fields, [
    { name: 'title', type: 'string', required: true },
    { name: 'rating', type: 'number', required: false, defaultValue: '3' },
    { name: 'label', type: 'string', required: false, defaultValue: 'New label' },
    { name: 'releaseDate', type: 'date', required: false, defaultValue: '2026-07-21' },
    { name: 'escapedLabel', type: 'string', required: false, defaultValue: "New 'label" },
  ]);
  assert.deepEqual(discovery.writable[0].omittedFields?.map(({ name }) => name), [
    'category', 'invalidDefault', 'invalidListDefault', 'dynamicDefault',
  ]);
});

test('validates defensive request, field, body, and empty index-directory paths', async (t) => {
  const fixture = await projectFixture(config);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sourceRoot, 'content/articles/example'), { recursive: true });
  await mkdir(path.join(fixture.sourceRoot, 'content/articles/empty-directory'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'content/articles/example/index.md'), '---\ntitle: Example\n---\n');
  const base = {
    collection: 'articles', slug: 'entry', values: { title: 'Title', description: 'Description' }, body: 'Body.',
  };
  await assert.rejects(createContentCollectionEntry(fixture.root, fixture.sourceRoot, null as never), /incomplete/i);
  await assert.rejects(createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...base, collection: 'missing' }), /not writable/i);
  await assert.rejects(createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...base, collection: 'remote' }), /loader-backed/i);
  for (const [request, message] of [
    [{ ...base, slug: 'blank-title', values: { title: '  ', description: 'Description' } }, /title.*required/i],
    [{ ...base, slug: 'bad-boolean', values: { ...base.values, published: 'maybe' } }, /published.*true or false/i],
    [{ ...base, slug: 'bad-date', values: { ...base.values, launchDate: '21 July 2026' } }, /launchDate.*date/i],
    [{ ...base, slug: 'long-title', values: { title: 'x'.repeat(10_001), description: 'Description' } }, /title.*too long/i],
    [{ ...base, slug: 'nul-body', body: 'before\0after' }, /starter body.*large|invalid text/i],
    [{ ...base, slug: 'large-body', body: 'x'.repeat(100_001) }, /starter body.*large|invalid text/i],
  ] as const) {
    await assert.rejects(createContentCollectionEntry(fixture.root, fixture.sourceRoot, request), message);
  }
  const created = await createContentCollectionEntry(fixture.root, fixture.sourceRoot, {
    ...base, slug: 'empty-directory',
  });
  assert.equal(created.file, 'src/content/articles/empty-directory/index.md');

  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-entry-link-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(fixture.sourceRoot, 'content/articles/linked-entry'), 'dir');
  await assert.rejects(
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, { ...base, slug: 'linked-entry' }),
    (error: unknown) => error instanceof CollectionEntryError && error.status === 403,
  );
});

test('returns static route restart guidance and handles projects without configs or routes', async (t) => {
  const fixture = await projectFixture(`
    const articles = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/articles' }), schema: z.object({ title: z.string() }) });
    export const collections = { articles };
  `);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sourceRoot, 'content/articles'), { recursive: true });
  await mkdir(path.join(fixture.sourceRoot, 'pages/articles'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'pages/articles/[slug].astro'), "export async function getStaticPaths() {} const entries = await getCollection('articles');");
  const created = await createContentCollectionEntry(fixture.root, fixture.sourceRoot, {
    collection: 'articles', slug: 'guided', values: { title: 'Guided' }, body: 'Body.',
  });
  assert.equal(created.route, undefined);
  assert.match(created.routeGuidance ?? '', /Restart Astro.*\/articles\/guided\//);

  const unrelated = await projectFixture(`
    const notes = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/notes' }), schema: z.object({ title: z.string() }) });
    export const collections = { notes };
  `);
  t.after(() => rm(unrelated.root, { recursive: true, force: true }));
  await mkdir(path.join(unrelated.sourceRoot, 'pages/notes'), { recursive: true });
  await writeFile(path.join(unrelated.sourceRoot, 'pages/notes/[slug].astro'), "const entries = await getCollection('other');");
  const noRoute = await discoverContentCollections(unrelated.root, unrelated.sourceRoot);
  assert.equal(noRoute.writable[0].routePattern, undefined);
  assert.equal(noRoute.writable[0].routeGuidancePattern, undefined);

  const noConfigRoot = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-no-config-'));
  const noConfigSource = path.join(noConfigRoot, 'src');
  await mkdir(noConfigSource, { recursive: true });
  t.after(() => rm(noConfigRoot, { recursive: true, force: true }));
  const noConfig = await discoverContentCollections(noConfigRoot, noConfigSource);
  assert.match(noConfig.unsupported[0].reason, /No src\/content\.config/i);
});

test('rejects project and content root escapes, oversized configs, and oversized collection scans', async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-project-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-source-root-'));
  const outsideSource = path.join(outside, 'src');
  await mkdir(outsideSource, { recursive: true });
  t.after(() => Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await assert.rejects(
    discoverContentCollections(project, outsideSource),
    (error: unknown) => error instanceof CollectionEntryError && error.status === 403,
  );

  const linked = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-linked-content-'));
  const linkedSource = path.join(linked, 'src');
  const linkedOutside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-linked-outside-'));
  await mkdir(linkedSource, { recursive: true });
  await symlink(linkedOutside, path.join(linkedSource, 'content'), 'dir');
  t.after(() => Promise.all([
    rm(linked, { recursive: true, force: true }),
    rm(linkedOutside, { recursive: true, force: true }),
  ]));
  await assert.rejects(
    discoverContentCollections(linked, linkedSource),
    (error: unknown) => error instanceof CollectionEntryError && error.status === 403,
  );

  const oversized = await projectFixture(' '.repeat(512 * 1024 + 1));
  t.after(() => rm(oversized.root, { recursive: true, force: true }));
  await assert.rejects(
    discoverContentCollections(oversized.root, oversized.sourceRoot),
    (error: unknown) => error instanceof CollectionEntryError && error.status === 413,
  );

  const crowded = await projectFixture(`
    const entries = defineCollection({ loader: glob({ pattern: '**/*.md', base: './src/content/entries' }), schema: z.object({ title: z.string() }) });
    export const collections = { entries };
  `);
  t.after(() => rm(crowded.root, { recursive: true, force: true }));
  const crowdedRoot = path.join(crowded.sourceRoot, 'content/entries');
  await mkdir(crowdedRoot, { recursive: true });
  for (let start = 0; start < 2_001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 2_001 - start) }, (_, offset) => (
      writeFile(path.join(crowdedRoot, `${start + offset}.md`), '---\ntitle: Entry\n---\n')
    )));
  }
  await assert.rejects(
    discoverContentCollections(crowded.root, crowded.sourceRoot),
    (error: unknown) => error instanceof CollectionEntryError && error.status === 413,
  );
});

test('uses flat MDX conventions, rejects executable starter markup, and confines symlinked roots', async (t) => {
  const mdxConfig = `
    const notes = defineCollection({
      loader: glob({ pattern: '**/*.mdx', base: './src/content/notes' }),
      schema: z.object({ title: z.string() }),
    });
    export const collections = { notes };
  `;
  const fixture = await projectFixture(mdxConfig);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(path.join(fixture.sourceRoot, 'content/notes'), { recursive: true });
  await writeFile(path.join(fixture.sourceRoot, 'content/notes/existing.mdx'), '---\ntitle: Existing\n---\n');
  const result = await createContentCollectionEntry(fixture.root, fixture.sourceRoot, {
    collection: 'notes', slug: 'next-note', values: { title: 'Next note' }, body: 'Plain MDX starter.',
  });
  assert.equal(result.file, 'src/content/notes/next-note.mdx');
  assert.equal(result.route, undefined);
  await assert.rejects(
    createContentCollectionEntry(fixture.root, fixture.sourceRoot, {
      collection: 'notes', slug: 'unsafe-note', values: { title: 'Unsafe' }, body: '{dangerousExpression}',
    }),
    /MDX starter body/i,
  );

  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(path.join(fixture.sourceRoot, 'content/notes'), { recursive: true });
  await symlink(outside, path.join(fixture.sourceRoot, 'content/notes'), 'dir');
  const discovery = await discoverContentCollections(fixture.root, fixture.sourceRoot);
  assert.equal(discovery.writable.length, 0);
  assert.match(discovery.unsupported[0].reason, /outside|linked/i);
});
