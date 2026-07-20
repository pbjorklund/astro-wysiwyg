import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const outputRoot = path.resolve('demo/dist');
const files = await listFiles(outputRoot);
for (const expected of [
  'index.html',
  'article/index.html',
  'mdx/index.html',
  'blocks/index.html',
  'content-blocks/index.html',
  'content-blocks-astro/index.html',
  'content-blocks-mdx/index.html',
  'images/index.html',
  'image-astro/index.html',
  'image-mdx/index.html',
  'videos/index.html',
  'video-astro/index.html',
  'video-mdx/index.html',
  'iframes/index.html',
  'iframe-astro/index.html',
  'iframe-mdx/index.html',
  'embed-preview/index.html',
  'resilience/index.html',
]) {
  assert.ok(files.includes(expected), `Missing demo production route: ${expected}`);
}

const textFiles = files.filter((file) => /\.(?:css|html|js|json|map|txt)$/i.test(file));
const output = (await Promise.all(textFiles.map((file) => readFile(path.join(outputRoot, file), 'utf8')))).join('\n');
const videoPage = await readFile(path.join(outputRoot, 'videos/index.html'), 'utf8');
assert.match(videoPage, /<video controls[^>]*preload="metadata"/);
assert.match(videoPage, /<source src="\/assets\/astro-wysiwyg-demo\.mp4" type="video\/mp4"/);
assert.match(videoPage, /<track kind="captions" src="\/assets\/astro-wysiwyg-demo\.vtt"/);
assert.match(videoPage, /<a href="\/assets\/astro-wysiwyg-demo\.mp4" download>/);
const contentBlocksPage = await readFile(path.join(outputRoot, 'content-blocks/index.html'), 'utf8');
assert.match(contentBlocksPage, /<blockquote>\s*<p>A source-backed blockquote for replacement\.<\/p>\s*<\/blockquote>/);
assert.match(contentBlocksPage, /<pre[^>]*data-language="text"/);
assert.match(contentBlocksPage, /<hr>/);
const iframePage = await readFile(path.join(outputRoot, 'iframes/index.html'), 'utf8');
assert.match(iframePage, /<iframe src="\/embed-preview" title="Local project status" width="560" height="220" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts"><\/iframe>/);
for (const forbidden of [
  '/_astro-wysiwyg/save',
  'astro-wysiwyg-toolbar',
  'startEditor(',
  'astro-wysiwyg/toolbar-app',
  'data-astro-wysiwyg-iframe',
  'astro-wysiwyg:create-collection-entry',
  'collections":"discover',
]) {
  assert.equal(output.includes(forbidden), false, `Production demo contains editor runtime marker: ${forbidden}`);
}

async function listFiles(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}
