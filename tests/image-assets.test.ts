import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ImageAssetError,
  imageUploadEndpoint,
  resolveExistingImageAsset,
  storeImageAsset,
  suggestImageFilename,
} from '../src/image-assets.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64').subarray(0, 42);

test('derives the upload endpoint and a portable destination name', () => {
  assert.equal(imageUploadEndpoint('/_astro-wysiwyg/save'), '/_astro-wysiwyg/save/assets');
  assert.equal(imageUploadEndpoint('/'), '/assets');
  assert.equal(suggestImageFilename('  Summer Photo (Final).PNG  '), 'summer-photo-final.png');
  assert.equal(suggestImageFilename('.hidden.jpeg'), 'hidden.jpeg');
  assert.equal(suggestImageFilename('---.webp'), 'image.webp');
  assert.equal(suggestImageFilename('photo'), 'photo');
});

test('stores supported image bytes under the configured public asset directory', async (t) => {
  const publicRoot = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-assets-'));
  t.after(() => rm(publicRoot, { recursive: true, force: true }));

  const result = await storeImageAsset({
    publicRoot,
    assetDirectory: 'media/editor',
    fileName: 'cover.png',
    contentType: 'image/png',
    bytes: PNG,
  });

  assert.equal(result.url, '/media/editor/cover.png');
  assert.deepEqual(await readFile(path.join(publicRoot, 'media/editor/cover.png')), PNG);

  for (const [fileName, contentType, bytes] of [
    ['photo.jpg', 'image/jpeg', JPEG],
    ['animation.gif', 'image/gif', GIF],
    ['preview.webp', 'image/webp', WEBP],
  ] as const) {
    const stored = await storeImageAsset({
      publicRoot, assetDirectory: 'media/editor', fileName, contentType, bytes,
    });
    assert.equal(stored.url, `/media/editor/${fileName}`);
  }
});

test('rejects unsafe names, directories, types, disguised files, and oversized images', async (t) => {
  const publicRoot = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-assets-'));
  t.after(() => rm(publicRoot, { recursive: true, force: true }));
  const base = {
    publicRoot,
    assetDirectory: 'assets',
    fileName: 'photo.png',
    contentType: 'image/png',
    bytes: PNG,
  };

  for (const fileName of ['../photo.png', 'folder/photo.png', 'folder\\photo.png', '.photo.png', 'photo.svg', 'photo.exe', 'photo.png?x']) {
    await assert.rejects(storeImageAsset({ ...base, fileName }), ImageAssetError);
  }
  for (const assetDirectory of ['../assets', '/tmp/assets', '.', 'assets/../../outside']) {
    await assert.rejects(storeImageAsset({ ...base, assetDirectory }), /asset directory/i);
  }
  await assert.rejects(
    storeImageAsset({ ...base, contentType: 'image/svg+xml', fileName: 'photo.svg' }),
    /supported PNG, JPEG, GIF, or WebP/i,
  );
  await assert.rejects(
    storeImageAsset({ ...base, contentType: 'image/jpeg' }),
    /supported PNG, JPEG, GIF, or WebP/i,
  );
  await assert.rejects(
    storeImageAsset({ ...base, bytes: Buffer.from('<script>alert(1)</script>') }),
    /not match/i,
  );
  await assert.rejects(
    storeImageAsset({ ...base, bytes: JPEG }),
    /not match/i,
  );
  await assert.rejects(
    storeImageAsset({ ...base, bytes: Buffer.concat([PNG, Buffer.from('<script>')]) }),
    /not match/i,
  );
  await assert.rejects(
    storeImageAsset({ ...base, bytes: PNG.subarray(0, 8) }),
    /not match/i,
  );
  const wrongHeaderLength = Buffer.alloc(32);
  PNG.copy(wrongHeaderLength, 0, 0, 8);
  wrongHeaderLength.writeUInt32BE(12, 8);
  wrongHeaderLength.write('IHDR', 12, 'ascii');
  await assert.rejects(
    storeImageAsset({ ...base, bytes: wrongHeaderLength }),
    /not match/i,
  );
  await assert.rejects(
    storeImageAsset({ ...base, bytes: Buffer.concat([PNG, Buffer.alloc(20)]), maxBytes: 16 }),
    /too large/i,
  );
});

test('resolves public and source image references without leaving their configured roots', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-assets-'));
  const publicRoot = path.join(root, 'public');
  const sourceRoot = path.join(root, 'src');
  const pageFile = path.join(sourceRoot, 'pages/page.md');
  await Promise.all([
    mkdir(path.join(publicRoot, 'images'), { recursive: true }),
    mkdir(path.join(sourceRoot, 'assets'), { recursive: true }),
    mkdir(path.dirname(pageFile), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(publicRoot, 'images/public.png'), PNG),
    writeFile(path.join(sourceRoot, 'assets/imported.png'), PNG),
    writeFile(pageFile, '![Image](../assets/imported.png)\n'),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const publicAsset = await resolveExistingImageAsset({
    projectRoot: root, publicRoot, sourceRoot, sourceFile: 'src/pages/page.md',
    reference: '/images/public.png',
  });
  assert.equal(publicAsset.kind, 'public');
  assert.equal(publicAsset.contentType, 'image/png');
  assert.equal(publicAsset.file, path.join(publicRoot, 'images/public.png'));

  const sourceAsset = await resolveExistingImageAsset({
    projectRoot: root, publicRoot: path.join(root, 'missing-public'), sourceRoot, sourceFile: 'src/pages/page.md',
    reference: '../assets/imported.png',
  });
  assert.equal(sourceAsset.kind, 'source');
  assert.equal(sourceAsset.file, path.join(sourceRoot, 'assets/imported.png'));
});

test('rejects missing, malformed, executable, and escaping existing asset references', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-assets-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-assets-outside-'));
  const publicRoot = path.join(root, 'public');
  const sourceRoot = path.join(root, 'src');
  const pageFile = path.join(sourceRoot, 'pages/page.mdx');
  await Promise.all([
    mkdir(publicRoot, { recursive: true }),
    mkdir(path.dirname(pageFile), { recursive: true }),
    writeFile(path.join(outside, 'outside.png'), PNG),
  ]);
  await Promise.all([
    writeFile(pageFile, 'Body\n'),
    mkdir(path.join(root, 'outside-source'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(publicRoot, 'script.svg'), '<svg><script /></svg>'),
    writeFile(path.join(publicRoot, 'broken.png'), '<script>'),
    writeFile(path.join(publicRoot, 'large.png'), Buffer.alloc(5_000_001)),
    mkdir(path.join(publicRoot, 'directory.png')),
    writeFile(path.join(root, 'outside-source/page.mdx'), 'Body\n'),
  ]);
  await symlink(path.join(outside, 'outside.png'), path.join(publicRoot, 'linked.png'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const base = { projectRoot: root, publicRoot, sourceRoot, sourceFile: 'src/pages/page.mdx' };

  for (const reference of [
    '/missing.png', '/script.svg', '/broken.png', '/large.png', '/directory.png', '/linked.png',
    '/../outside.png', '../../outside.png', 'https://example.com/image.png',
    '/image.png?query', '/image.png#hash',
  ]) {
    await assert.rejects(resolveExistingImageAsset({ ...base, reference }), ImageAssetError);
  }
  await assert.rejects(resolveExistingImageAsset({
    ...base, publicRoot: path.join(root, 'missing-public'), reference: '/missing.png',
  }), /does not exist/i);
  await assert.rejects(resolveExistingImageAsset({
    ...base, sourceFile: 'src/missing.mdx', reference: '../outside.png',
  }), /source file no longer exists/i);
  await assert.rejects(resolveExistingImageAsset({
    ...base, sourceFile: 'outside-source/page.mdx', reference: '../outside.png',
  }), /outside the Astro source directory/i);
});

test('rejects duplicate names and linked asset roots without changing existing files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-assets-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-assets-outside-'));
  const publicRoot = path.join(root, 'public');
  await mkdir(path.join(publicRoot, 'assets'), { recursive: true });
  await writeFile(path.join(publicRoot, 'assets/existing.png'), JPEG);
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));

  await assert.rejects(storeImageAsset({
    publicRoot,
    assetDirectory: 'assets',
    fileName: 'existing.png',
    contentType: 'image/png',
    bytes: PNG,
  }), /already exists/i);
  assert.deepEqual(await readFile(path.join(publicRoot, 'assets/existing.png')), JPEG);

  await rm(path.join(publicRoot, 'assets'), { recursive: true });
  await symlink(outside, path.join(publicRoot, 'assets'));
  await assert.rejects(storeImageAsset({
    publicRoot,
    assetDirectory: 'assets',
    fileName: 'escape.png',
    contentType: 'image/png',
    bytes: PNG,
  }), /outside/i);
  await assert.rejects(readFile(path.join(outside, 'escape.png')));
});
