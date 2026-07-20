import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_VIDEO_MAX_BYTES,
  VideoAssetError,
  normalizeVideoAssetDirectory,
  resolveExistingVideoAsset,
  storeVideoAsset,
  videoUploadEndpoint,
} from '../src/video-assets.ts';
import { suggestVideoFilename } from '../src/video-rules.ts';

function box(type: string, payload = Buffer.alloc(0)): Buffer {
  const value = Buffer.alloc(8 + payload.length);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, 4, 'ascii');
  payload.copy(value, 8);
  return value;
}

function extendedBox(type: string, payload = Buffer.alloc(0)): Buffer {
  const value = Buffer.alloc(16 + payload.length);
  value.writeUInt32BE(1, 0);
  value.write(type, 4, 4, 'ascii');
  value.writeBigUInt64BE(BigInt(value.length), 8);
  payload.copy(value, 16);
  return value;
}

function mp4(codec = 'avc1', ftypBox = box): Buffer {
  const ftyp = ftypBox('ftyp', Buffer.from('isom\u0000\u0000\u0000\u0000isomavc1'));
  const sample = box(codec, Buffer.alloc(78));
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), sample]));
  const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))));
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.from([0, 0, 0, 1]))]);
}

function mp4WithStsd(payload: Buffer): Buffer {
  const ftyp = box('ftyp', Buffer.from('isom\u0000\u0000\u0000\u0000isomavc1'));
  return Buffer.concat([ftyp, box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', payload))))))]);
}

const MP4 = mp4();

test('derives video upload paths and safe destination names', () => {
  assert.equal(videoUploadEndpoint('/_astro-wysiwyg/save'), '/_astro-wysiwyg/save/videos');
  assert.equal(videoUploadEndpoint('/edit/'), '/edit/videos');
  assert.equal(suggestVideoFilename(' Product Walkthrough.MP4 '), 'product-walkthrough.mp4');
  assert.equal(suggestVideoFilename('---.mp4'), 'video.mp4');
  assert.equal(suggestVideoFilename('Launch recording'), 'launch-recording.mp4');
  assert.equal(normalizeVideoAssetDirectory('media/videos'), 'media/videos');
});

test('stores an H.264 MP4 atomically under the configured public directory', async (t) => {
  const publicRoot = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-'));
  t.after(() => rm(publicRoot, { recursive: true, force: true }));

  const result = await storeVideoAsset({
    publicRoot,
    assetDirectory: 'media/videos',
    fileName: 'walkthrough.mp4',
    contentType: 'video/mp4; codecs="avc1.42E01E"',
    bytes: MP4,
  });

  assert.equal(result.url, '/media/videos/walkthrough.mp4');
  assert.deepEqual(await readFile(result.file), MP4);
});

test('rejects unsafe video paths, unsupported containers and codecs, and oversized files', async (t) => {
  const publicRoot = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-'));
  t.after(() => rm(publicRoot, { recursive: true, force: true }));
  const base = {
    publicRoot,
    assetDirectory: 'videos',
    fileName: 'clip.mp4',
    contentType: 'video/mp4',
    bytes: MP4,
  };

  for (const fileName of ['../clip.mp4', 'folder/clip.mp4', '.clip.mp4', 'clip.mov', 'clip.webm', 'clip.mp4?x']) {
    await assert.rejects(storeVideoAsset({ ...base, fileName }), VideoAssetError);
  }
  for (const assetDirectory of ['../videos', '/tmp/videos', '.', 'videos/../../outside']) {
    await assert.rejects(storeVideoAsset({ ...base, assetDirectory }), /asset directory/i);
  }
  await assert.rejects(storeVideoAsset({ ...base, contentType: 'video/quicktime' }), /H\.264 MP4/i);
  await assert.rejects(storeVideoAsset({ ...base, bytes: Buffer.alloc(0) }), /Choose a video/i);
  await assert.rejects(storeVideoAsset({ ...base, bytes: mp4('hvc1') }), /H\.264/i);
  await assert.rejects(storeVideoAsset({ ...base, bytes: Buffer.from('<video>not mp4</video>') }), /valid MP4/i);
  const malformed = Buffer.from(MP4);
  malformed.writeUInt32BE(0xffff_ffff, 0);
  const incompleteExtended = Buffer.alloc(8);
  incompleteExtended.writeUInt32BE(1, 0);
  incompleteExtended.write('ftyp', 4, 4, 'ascii');
  const unsafeExtended = Buffer.alloc(16);
  unsafeExtended.writeUInt32BE(1, 0);
  unsafeExtended.write('ftyp', 4, 4, 'ascii');
  unsafeExtended.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
  const invalidEntry = Buffer.alloc(16);
  invalidEntry.writeUInt32BE(1, 4);
  invalidEntry.writeUInt32BE(4, 8);
  invalidEntry.write('avc1', 12, 4, 'ascii');
  const oversizedEntry = Buffer.from(invalidEntry);
  oversizedEntry.writeUInt32BE(100, 8);
  for (const bytes of [
    malformed,
    Buffer.concat([MP4, Buffer.alloc(4)]),
    incompleteExtended,
    unsafeExtended,
    box('moov', Buffer.alloc(4)),
    mp4WithStsd(Buffer.alloc(7)),
    mp4WithStsd(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])),
    mp4WithStsd(invalidEntry),
    mp4WithStsd(oversizedEntry),
    mp4WithStsd(Buffer.alloc(9)),
  ]) {
    await assert.rejects(storeVideoAsset({ ...base, bytes }), /valid MP4/i);
  }
  await assert.rejects(
    storeVideoAsset({ ...base, bytes: Buffer.concat([MP4, Buffer.alloc(20)]), maxBytes: 16 }),
    /too large/i,
  );
  assert.equal(DEFAULT_VIDEO_MAX_BYTES, 100_000_000);
});

test('accepts extended, zero-sized, and avc3 MP4 boxes', async (t) => {
  const publicRoot = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-'));
  t.after(() => rm(publicRoot, { recursive: true, force: true }));
  const zeroSizedTail = Buffer.alloc(8);
  zeroSizedTail.write('free', 4, 4, 'ascii');
  const variants = [
    ['extended.mp4', mp4('avc1', extendedBox)],
    ['zero-sized.mp4', Buffer.concat([MP4, zeroSizedTail])],
    ['avc3.mp4', mp4('avc3')],
  ] as const;

  for (const [fileName, bytes] of variants) {
    const result = await storeVideoAsset({
      publicRoot,
      assetDirectory: 'videos',
      fileName,
      contentType: 'video/mp4',
      bytes,
    });
    assert.deepEqual(await readFile(result.file), bytes);
  }
});

test('resolves only bounded H.264 MP4 files inside the public root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-existing-'));
  const publicRoot = path.join(root, 'public');
  const outside = path.join(root, 'outside.mp4');
  await mkdir(path.join(publicRoot, 'media'), { recursive: true });
  await Promise.all([
    writeFile(path.join(publicRoot, 'media/tour.mp4'), MP4),
    writeFile(path.join(publicRoot, 'media/hevc.mp4'), mp4('hvc1')),
    writeFile(path.join(publicRoot, 'media/broken.mp4'), 'not an mp4'),
    writeFile(outside, MP4),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    resolveExistingVideoAsset({ publicRoot: path.join(root, 'missing-public'), reference: '/media/tour.mp4' }),
    /does not exist/i,
  );
  const result = await resolveExistingVideoAsset({ publicRoot, reference: '/media/tour.mp4' });
  assert.equal(result.reference, '/media/tour.mp4');
  assert.equal(result.size, MP4.length);
  assert.equal(result.file, path.join(publicRoot, 'media/tour.mp4'));
  for (const reference of ['/media/missing.mp4', '/media/hevc.mp4', '/media/broken.mp4', '/../outside.mp4', 'media/tour.mp4']) {
    await assert.rejects(resolveExistingVideoAsset({ publicRoot, reference }), VideoAssetError);
  }
  await assert.rejects(
    resolveExistingVideoAsset({ publicRoot, reference: '/media/tour.mp4', maxBytes: 8 }),
    /supported video/i,
  );
  await symlink(outside, path.join(publicRoot, 'media/escape.mp4'));
  await assert.rejects(
    resolveExistingVideoAsset({ publicRoot, reference: '/media/escape.mp4' }),
    /outside/i,
  );
});

test('rejects duplicate destinations and linked asset roots without changing existing files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-outside-'));
  const publicRoot = path.join(root, 'public');
  await mkdir(path.join(publicRoot, 'videos'), { recursive: true });
  await writeFile(path.join(publicRoot, 'videos/existing.mp4'), 'keep');
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const options = {
    publicRoot,
    assetDirectory: 'videos',
    fileName: 'existing.mp4',
    contentType: 'video/mp4',
    bytes: MP4,
  };

  await assert.rejects(storeVideoAsset(options), /already exists/i);
  assert.equal(await readFile(path.join(publicRoot, 'videos/existing.mp4'), 'utf8'), 'keep');

  const linkedRoot = path.join(publicRoot, 'linked');
  await symlink(outside, linkedRoot, 'dir');
  await assert.rejects(storeVideoAsset({ ...options, assetDirectory: 'linked', fileName: 'escape.mp4' }), /outside/i);
  await assert.rejects(readFile(path.join(outside, 'escape.mp4')));
});
