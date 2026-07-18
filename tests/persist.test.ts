import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applySourceEdit, applySourceStructureEdit } from '../src/persist.ts';
import { createMarker, decodeMarker, encodeMarker } from '../src/marker.ts';

async function fixture(source: string, extension = '.md') {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-'));
  const file = path.join(root, `page${extension}`);
  await writeFile(file, source);
  return { root: await realpath(root), file };
}

test('marker encoding is URL and HTML attribute safe', () => {
  const token = encodeMarker(createMarker('src/page.md', 4, 12, '**hello**', 'markdown', 'p'));
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeMarker(token), {
    version: 1,
    file: 'src/page.md',
    start: 4,
    end: 12,
    original: '**hello**',
    format: 'markdown',
    tag: 'p',
  });
});

test('saves rich HTML as Markdown while preserving surrounding source', async (t) => {
  const source = 'Before\n\nOld text\n\nAfter\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('Old text');
  const token = encodeMarker(createMarker('page.md', start, start + 8, 'Old text', 'markdown', 'p'));

  const result = await applySourceEdit(root, {
    marker: token,
    html: 'New <strong>bold</strong> and <em>italic</em> text',
  });

  assert.equal(await readFile(file, 'utf8'), 'Before\n\nNew **bold** and _italic_ text\n\nAfter\n');
  assert.equal(decodeMarker(result.marker).original, 'New **bold** and _italic_ text');
});

test('keeps marker coordinates stable when rendered positions exclude frontmatter', async (t) => {
  const source = '---\ntitle: Example\n---\nBody text\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 9, 'Body text', 'markdown', 'p'));

  const result = await applySourceEdit(root, { marker: token, html: 'Changed body' });

  assert.equal(await readFile(file, 'utf8'), '---\ntitle: Example\n---\nChanged body\n');
  assert.equal(decodeMarker(result.marker).start, 0);
});

test('adds a Markdown paragraph after the selected block', async (t) => {
  const source = 'First block\n\nSecond block\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'First block', 'markdown', 'p'));

  const result = await applySourceStructureEdit(root, { marker: token, operation: 'insert-after' });

  assert.equal(await readFile(file, 'utf8'), 'First block\n\nNew paragraph\n\nSecond block\n');
  assert.equal(decodeMarker(result.marker!).original, 'New paragraph');
  assert.equal(decodeMarker(result.marker!).start, 13);
});

test('adds an Astro paragraph with the selected block indentation', async (t) => {
  const source = '<div>\n  <p>First</p>\n  <p>Second</p>\n</div>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('<p>First</p>');
  const token = encodeMarker(createMarker('page.astro', start, start + 12, '<p>First</p>', 'astro', 'p'));

  await applySourceStructureEdit(root, { marker: token, operation: 'insert-after' });

  assert.equal(
    await readFile(file, 'utf8'),
    '<div>\n  <p>First</p>\n  <p>New paragraph</p>\n  <p>Second</p>\n</div>\n',
  );
});

test('deletes only the selected Markdown block and its separator', async (t) => {
  const source = 'First block\n\nSecond block\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'First block', 'markdown', 'p'));

  const result = await applySourceStructureEdit(root, { marker: token, operation: 'delete' });

  assert.equal(await readFile(file, 'utf8'), 'Second block\n');
  assert.equal(result.marker, undefined);
});

test('deletes an Astro block without leaving an empty indented line', async (t) => {
  const source = '<div>\n  <p>First</p>\n  <p>Second</p>\n</div>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('<p>First</p>');
  const token = encodeMarker(createMarker('page.astro', start, start + 12, '<p>First</p>', 'astro', 'p'));

  await applySourceStructureEdit(root, { marker: token, operation: 'delete' });

  assert.equal(await readFile(file, 'utf8'), '<div>\n  <p>Second</p>\n</div>\n');
});

test('rejects structural edits to frontmatter fields', async (t) => {
  const source = '---\ntitle: Example\n---\nBody\n';
  const { root } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 7, 21, 'title: Example', 'frontmatter', 'h1'));

  await assert.rejects(
    applySourceStructureEdit(root, { marker: token, operation: 'delete' }),
    /Frontmatter fields cannot be added or deleted/,
  );
});

test('updates a quoted frontmatter title as plain text', async (t) => {
  const source = '---\ntitle: "Old title"\n---\nBody\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('"Old title"');
  const token = encodeMarker(createMarker('page.md', start, start + 11, '"Old title"', 'frontmatter', 'h1'));

  await applySourceEdit(root, {
    marker: token,
    html: 'New &amp; better title',
    text: 'New & better title',
    tag: 'h1',
  });

  assert.equal(await readFile(file, 'utf8'), '---\ntitle: "New & better title"\n---\nBody\n');
});

test('preserves a Markdown list marker while editing an item', async (t) => {
  const source = '- Old **item**\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, source.trimEnd().length, source.trimEnd(), 'markdown', 'li'));

  await applySourceEdit(root, { marker: token, html: 'New <strong>item</strong>', tag: 'li' });

  assert.equal(await readFile(file, 'utf8'), '- New **item**\n');
});

test('changes a Markdown paragraph to a bullet list', async (t) => {
  const source = 'One and two\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'One and two', 'markdown', 'p'));

  await applySourceEdit(root, {
    marker: token,
    html: '<li>One</li><li>Two</li>',
    tag: 'ul',
  });

  assert.equal(await readFile(file, 'utf8'), '- One\n- Two\n');
});

test('changes a Markdown paragraph to a heading', async (t) => {
  const source = 'A paragraph\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'A paragraph', 'markdown', 'p'));

  await applySourceEdit(root, { marker: token, html: 'A title', tag: 'h1' });

  assert.equal(await readFile(file, 'utf8'), '# A title\n');
});

test('relocates an unchanged unique block after an earlier edit shifted offsets', async (t) => {
  const source = 'First\n\nSecond\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const secondStart = source.indexOf('Second');
  const staleToken = encodeMarker(createMarker('page.md', secondStart, secondStart + 6, 'Second', 'markdown', 'p'));
  await writeFile(file, 'A much longer first paragraph\n\nSecond\n');

  await applySourceEdit(root, { marker: staleToken, html: 'Updated second' });

  assert.equal(await readFile(file, 'utf8'), 'A much longer first paragraph\n\nUpdated second\n');
});

test('rejects paths outside the project root', async (t) => {
  const { root } = await fixture('safe');
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('../outside.md', 0, 4, 'safe', 'markdown', 'p'));

  await assert.rejects(
    applySourceEdit(root, { marker: token, html: 'unsafe' }),
    /outside the Astro project root/,
  );
});

test('preserves Astro element attributes and changes only its static inner HTML', async (t) => {
  const source = '<p class="lead">Old <em>text</em></p>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = source.trimEnd();
  const token = encodeMarker(createMarker('page.astro', 0, original.length, original, 'astro', 'p'));

  await applySourceEdit(root, { marker: token, html: 'New <strong>text</strong>' });

  assert.equal(await readFile(file, 'utf8'), '<p class="lead">New <strong>text</strong></p>\n');
});
