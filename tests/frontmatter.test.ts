import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFrontmatterFields, updateFrontmatterFields } from '../src/frontmatter.ts';
import { createMarker, encodeMarker } from '../src/marker.ts';

test('reads and updates simple frontmatter fields in one pass', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-frontmatter-'));
  const file = path.join(root, 'src/content/articles/post.md');
  await mkdir(path.dirname(file), { recursive: true });
  const source = `---
title: "Old title"
description: 'Old description'
publishedAt: 2026-06-24
publishedHour: 14
tags: ["ai", "software"]
aiDisclaimer: false
---
Body text.
`;
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodyStart = source.indexOf('Body text.');
  const contextMarker = encodeMarker(createMarker(
    'src/content/articles/post.md', bodyStart, bodyStart + 10, 'Body text.', 'markdown', 'p',
  ));

  const fields = await readFrontmatterFields(root, contextMarker);
  assert.deepEqual(fields.map(({ name, type, value }) => ({ name, type, value })), [
    { name: 'title', type: 'string', value: 'Old title' },
    { name: 'description', type: 'string', value: 'Old description' },
    { name: 'publishedAt', type: 'date', value: '2026-06-24' },
    { name: 'publishedHour', type: 'number', value: '14' },
    { name: 'tags', type: 'list', value: 'ai, software' },
    { name: 'aiDisclaimer', type: 'boolean', value: false },
  ]);

  await updateFrontmatterFields(root, contextMarker, {
    title: 'New title',
    publishedAt: '2026-07-01',
    tags: 'ai, editing',
    aiDisclaimer: true,
  });

  assert.equal(await readFile(file, 'utf8'), `---
title: "New title"
description: 'Old description'
publishedAt: 2026-07-01
publishedHour: 14
tags: ["ai","editing"]
aiDisclaimer: true
---
Body text.
`);
});

test('rejects invalid typed frontmatter without changing the file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-frontmatter-'));
  const file = path.join(root, 'post.md');
  const source = '---\npublishedAt: 2026-06-24\npublishedHour: 14\n---\nBody.\n';
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const contextMarker = encodeMarker(createMarker('post.md', 52, 57, 'Body.', 'markdown', 'p'));

  await assert.rejects(
    updateFrontmatterFields(root, contextMarker, { publishedHour: 'afternoon' }),
    /must be a number/,
  );
  await assert.rejects(
    updateFrontmatterFields(root, contextMarker, { publishedAt: 'June 24' }),
    /must use YYYY-MM-DD/,
  );
  assert.equal(await readFile(file, 'utf8'), source);
});

test('rejects a frontmatter context outside the project root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-frontmatter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contextMarker = encodeMarker(createMarker('../outside.md', 0, 1, 'x', 'markdown', 'p'));

  await assert.rejects(readFrontmatterFields(root, contextMarker), /outside the Astro project root/);
});
