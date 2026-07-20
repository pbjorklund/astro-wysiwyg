import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isInsideProjectRoot } from './project-path.ts';
export { videoUploadEndpoint } from './video-rules.ts';

export const DEFAULT_VIDEO_MAX_BYTES = 100_000_000;

interface StoreVideoAssetOptions {
  publicRoot: string;
  assetDirectory: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  maxBytes?: number;
}

export interface StoredVideoAsset {
  file: string;
  url: string;
}

export class VideoAssetError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

export async function storeVideoAsset(options: StoreVideoAssetOptions): Promise<StoredVideoAsset> {
  const assetDirectory = normalizeVideoAssetDirectory(options.assetDirectory);
  const fileName = validateVideoFileName(options.fileName);
  const maxBytes = options.maxBytes ?? DEFAULT_VIDEO_MAX_BYTES;
  if (options.bytes.length === 0) throw new VideoAssetError('Choose a video file to upload.');
  if (options.bytes.length > maxBytes) {
    throw new VideoAssetError(`The video is too large. The maximum size is ${maxBytes} bytes.`, 413);
  }
  const contentType = options.contentType.toLowerCase().split(';', 1)[0].trim();
  if (contentType !== 'video/mp4') {
    throw new VideoAssetError('Choose an H.264 MP4 video.');
  }
  const inspection = inspectMp4(options.bytes);
  if (!inspection.valid) throw new VideoAssetError('The file is not a valid MP4 container.');
  if (!inspection.h264) throw new VideoAssetError('The MP4 video must use the H.264 codec.');

  const publicRoot = await realpath(options.publicRoot);
  const requestedRoot = path.resolve(publicRoot, ...assetDirectory.split('/'));
  await mkdir(requestedRoot, { recursive: true });
  const assetRoot = await realpath(requestedRoot);
  if (!isInsideProjectRoot(publicRoot, assetRoot)) {
    throw new VideoAssetError('The video asset directory is outside the Astro public directory.', 403);
  }
  const destination = path.join(assetRoot, fileName);
  if (await lstat(destination).then(() => true, () => false)) {
    throw new VideoAssetError(`A video named "${fileName}" already exists. Choose another name.`, 409);
  }
  const temporary = path.join(assetRoot, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(options.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { file: destination, url: `/${assetDirectory}/${fileName}` };
}

export function normalizeVideoAssetDirectory(value: string): string {
  if (!value || value === '.' || path.isAbsolute(value) || value.includes('\\')) {
    throw new VideoAssetError('The video asset directory must be a relative path inside Astro public files.');
  }
  const normalized = value.split('/').filter(Boolean).join('/');
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..')) {
    throw new VideoAssetError('The video asset directory must be a relative path inside Astro public files.');
  }
  return normalized;
}

function validateVideoFileName(value: string): string {
  const fileName = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.mp4$/i.test(fileName)
    || path.basename(fileName) !== fileName) {
    throw new VideoAssetError('Choose a safe destination name ending in .mp4.');
  }
  return fileName;
}

function inspectMp4(bytes: Buffer): { valid: boolean; h264: boolean } {
  let foundFtyp = false;
  let h264 = false;
  const visit = (start: number, end: number): boolean => {
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) return false;
      let size = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return false;
        const largeSize = bytes.readBigUInt64BE(offset + 8);
        if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        size = Number(largeSize);
        headerSize = 16;
      } else if (size === 0) size = end - offset;
      if (size < headerSize || offset + size > end) return false;
      const payloadStart = offset + headerSize;
      const boxEnd = offset + size;
      if (type === 'ftyp') foundFtyp = true;
      if (CONTAINER_BOXES.has(type) && !visit(payloadStart, boxEnd)) return false;
      if (type === 'stsd') {
        if (payloadStart + 8 > boxEnd) return false;
        const entries = bytes.readUInt32BE(payloadStart + 4);
        let entryOffset = payloadStart + 8;
        for (let index = 0; index < entries; index += 1) {
          if (entryOffset + 8 > boxEnd) return false;
          const entrySize = bytes.readUInt32BE(entryOffset);
          const codec = bytes.subarray(entryOffset + 4, entryOffset + 8).toString('ascii');
          if (entrySize < 8 || entryOffset + entrySize > boxEnd) return false;
          if (codec === 'avc1' || codec === 'avc3') h264 = true;
          entryOffset += entrySize;
        }
        if (entryOffset !== boxEnd) return false;
      }
      offset = boxEnd;
    }
    return offset === end;
  };
  const valid = visit(0, bytes.length);
  return { valid: valid && foundFtyp, h264 };
}
