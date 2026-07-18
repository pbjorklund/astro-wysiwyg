import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarker, decodeMarker, encodeMarker } from '../src/marker.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { annotateAstroSource, resolveAstroSourceMarker } from '../src/astro-transform.ts';
import { rehypeEditableBlocks } from '../src/rehype.ts';

function markerFromHtml(html: string): string {
  const match = html.match(/data-astro-wysiwyg="([A-Za-z0-9_-]+)"/);
  assert.ok(match, `No editor marker in ${html}`);
  return match[1];
}

test('annotates static Astro blocks without changing their source range', async () => {
  const source = '---\nconst title = "Dynamic";\n---\n<main><h1 class="title">Static <em>title</em></h1><p>{title}</p></main>';
  const transformed = await annotateAstroSource(source, '/project/src/pages/index.astro', '/project');

  assert.match(transformed ?? '', /<h1 class="title" data-astro-wysiwyg="/);
  assert.doesNotMatch(transformed ?? '', /<p data-astro-wysiwyg/);
  const marker = decodeMarker(markerFromHtml(transformed ?? ''));
  assert.equal(marker.file, 'src/pages/index.astro');
  assert.equal(marker.original, '<h1 class="title">Static <em>title</em></h1>');
  assert.equal(source.slice(marker.start, marker.end), marker.original);
});

test('resolves Astro dev source locations to safe static blocks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-resolve-'));
  const file = path.join(root, 'page.astro');
  const source = '<main>\n  <p class="lead">Editable text</p>\n  <p>{dynamic}</p>\n</main>';
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));

  const token = await resolveAstroSourceMarker(root, file, '2:19');
  assert.equal(decodeMarker(token).original, '<p class="lead">Editable text</p>');
  await assert.rejects(resolveAstroSourceMarker(root, file, '3:6'), /not a static editable block/);
});

test('resolves a dynamic data title through the current content marker', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-title-'));
  const pageFile = path.join(root, 'src/pages/article.astro');
  const contentFile = path.join(root, 'src/content/articles/post.md');
  await Promise.all([
    mkdir(path.dirname(pageFile), { recursive: true }),
    mkdir(path.dirname(contentFile), { recursive: true }),
  ]);
  await writeFile(pageFile, '<h1 class="title">{article.data.title}</h1>');
  const content = '---\ntitle: "Current title"\n---\nBody text\n';
  await writeFile(contentFile, content);
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodyStart = content.indexOf('Body text');
  const context = encodeMarker(createMarker(
    'src/content/articles/post.md', bodyStart, bodyStart + 9, 'Body text', 'markdown', 'p',
  ));

  const token = await resolveAstroSourceMarker(root, pageFile, '1:22', {
    contextMarker: context,
    renderedText: 'Current title',
  });
  const marker = decodeMarker(token);
  assert.equal(marker.file, 'src/content/articles/post.md');
  assert.equal(marker.format, 'frontmatter');
  assert.equal(marker.original, '"Current title"');
});

test('resolves a rendered article card through its linked content slug', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-card-'));
  const pageFile = path.join(root, 'src/components/Card.astro');
  const contentFile = path.join(root, 'src/content/articles/example/index.md');
  await Promise.all([
    mkdir(path.dirname(pageFile), { recursive: true }),
    mkdir(path.dirname(contentFile), { recursive: true }),
  ]);
  await writeFile(pageFile, '<a href="/articles/example"><h2>{article.data.title}</h2></a>');
  await writeFile(contentFile, '---\ntitle: "Rendered card title"\ndescription: "Summary"\n---\nBody\n');
  t.after(() => rm(root, { recursive: true, force: true }));

  const token = await resolveAstroSourceMarker(root, pageFile, '1:42', {
    contextHref: '/articles/example',
    renderedText: 'Rendered card title',
  });
  const marker = decodeMarker(token);
  assert.equal(marker.file, 'src/content/articles/example/index.md');
  assert.equal(marker.format, 'frontmatter');
  assert.equal(marker.original, '"Rendered card title"');
});

test('annotates positioned Markdown paragraphs and headings', () => {
  const source = '# Heading\n\nText with **weight**.\n';
  const tree = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'h1',
        properties: {},
        children: [{ type: 'text', value: 'Heading' }],
        position: { start: { offset: 0 }, end: { offset: 9 } },
      },
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [{ type: 'text', value: 'Text with ' }, { type: 'element', tagName: 'strong', properties: {}, children: [] }],
        position: { start: { offset: 11 }, end: { offset: 32 } },
      },
    ],
  };
  const transform = rehypeEditableBlocks({ root: '/project' });
  transform(tree, { path: '/project/src/pages/article.md', value: source });

  const heading = tree.children[0];
  const paragraph = tree.children[1];
  const headingToken = String(heading.properties['data-astro-wysiwyg']);
  const paragraphToken = String(paragraph.properties['data-astro-wysiwyg']);
  assert.equal(decodeMarker(headingToken).original, '# Heading');
  assert.equal(decodeMarker(paragraphToken).original, 'Text with **weight**.');
});

test('annotates a static Markdown list as one editable block', () => {
  const source = '- First item';
  const tree = {
    type: 'root',
    children: [{
      type: 'element', tagName: 'ul', properties: {},
      position: { start: { offset: 0 }, end: { offset: source.length } },
      children: [{
        type: 'element', tagName: 'li', properties: {},
        children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'First item' }] }],
        position: { start: { offset: 0 }, end: { offset: source.length } },
      }],
    }],
  };
  rehypeEditableBlocks({ root: '/project' })(tree, { path: '/project/list.md', value: source });

  assert.equal(decodeMarker(String(tree.children[0].properties['data-astro-wysiwyg'])).tag, 'ul');
  assert.equal(tree.children[0].children[0].properties['data-astro-wysiwyg'], undefined);
});

test('does not annotate Markdown blocks containing MDX components', () => {
  const source = 'Text <Widget />';
  const tree = {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'text', value: 'Text ' }, { type: 'mdxJsxTextElement', name: 'Widget', children: [] }],
      position: { start: { offset: 0 }, end: { offset: source.length } },
    }],
  };
  const transform = rehypeEditableBlocks({ root: '/project' });
  transform(tree, { path: '/project/src/pages/article.mdx', value: source });

  assert.equal(tree.children[0].properties['data-astro-wysiwyg'], undefined);
});
