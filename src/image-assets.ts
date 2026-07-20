import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isInsideProjectRoot } from './project-path.ts';

export { imageUploadEndpoint, suggestImageFilename } from './image-rules.ts';

export const DEFAULT_IMAGE_MAX_BYTES = 5_000_000;

interface StoreImageAssetOptions {
  publicRoot: string;
  assetDirectory: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  maxBytes?: number;
}

export interface StoredImageAsset {
  file: string;
  url: string;
}

interface ResolveExistingImageAssetOptions {
  projectRoot: string;
  publicRoot: string;
  sourceRoot: string;
  sourceFile: string;
  reference: string;
}

export interface ExistingImageAsset {
  bytes: Buffer;
  contentType: string;
  file: string;
  kind: 'public' | 'source';
  reference: string;
}

export class ImageAssetError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const IMAGE_TYPES = [
  { extensions: ['.png'], mime: 'image/png', matches: isPng },
  { extensions: ['.jpg', '.jpeg'], mime: 'image/jpeg', matches: isJpeg },
  { extensions: ['.gif'], mime: 'image/gif', matches: isGif },
  { extensions: ['.webp'], mime: 'image/webp', matches: isWebp },
] as const;

function isPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const end = offset + 12 + length;
    if (end > bytes.length || (first && (type !== 'IHDR' || length !== 13))) return false;
    if (type === 'IEND') return length === 0 && end === bytes.length;
    first = false;
    offset = end;
  }
  return false;
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes.at(-2) === 0xff
    && bytes.at(-1) === 0xd9;
}

function isGif(bytes: Buffer): boolean {
  return bytes.length >= 7
    && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    && bytes.at(-1) === 0x3b;
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 16
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.readUInt32LE(4) === bytes.length - 8
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'));
}

export async function storeImageAsset(options: StoreImageAssetOptions): Promise<StoredImageAsset> {
  const assetDirectory = normalizeImageAssetDirectory(options.assetDirectory);
  const fileName = validateFileName(options.fileName);
  const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES;
  if (options.bytes.length === 0) throw new ImageAssetError('Choose an image file to upload.');
  if (options.bytes.length > maxBytes) {
    throw new ImageAssetError(`The image is too large. The maximum size is ${maxBytes} bytes.`, 413);
  }

  const contentType = options.contentType.toLowerCase().split(';', 1)[0].trim();
  const imageType = imageTypeFor(fileName);
  if (imageType.mime !== contentType) {
    throw new ImageAssetError('Choose a supported PNG, JPEG, GIF, or WebP image.');
  }
  if (!imageType.matches(options.bytes)) {
    throw new ImageAssetError('The file contents do not match the selected image type.');
  }

  const publicRoot = await realpath(options.publicRoot);
  const requestedRoot = path.resolve(publicRoot, ...assetDirectory.split('/'));
  await mkdir(requestedRoot, { recursive: true });
  const assetRoot = await realpath(requestedRoot);
  if (!isInsideProjectRoot(publicRoot, assetRoot)) {
    throw new ImageAssetError('The image asset directory is outside the Astro public directory.', 403);
  }

  const destination = path.join(assetRoot, fileName);
  const destinationExists = await lstat(destination).then(() => true, () => false);
  if (destinationExists) {
    throw new ImageAssetError(`An image named "${fileName}" already exists. Choose another name.`, 409);
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

  return {
    file: destination,
    url: `/${assetDirectory}/${fileName}`,
  };
}

export async function resolveExistingImageAsset(
  options: ResolveExistingImageAssetOptions,
): Promise<ExistingImageAsset> {
  const reference = options.reference.trim();
  if (!reference
    || /[\u0000-\u001f\u007f?#\\]/.test(reference)
    || reference.split('/').includes('..') && reference.startsWith('/')) {
    throw new ImageAssetError('Choose a valid project image reference.');
  }
  const kind = reference.startsWith('/') ? 'public' : 'source';
  if (kind === 'source' && (!/^\.{0,2}\/?[A-Za-z0-9._/-]+$/.test(reference) || /^[a-z]+:/i.test(reference))) {
    throw new ImageAssetError('Choose a valid project image reference.');
  }
  const imageType = imageTypeFor(reference);
  const [projectRoot, sourceRoot] = await Promise.all([
    realpath(options.projectRoot),
    realpath(options.sourceRoot),
  ]);
  const publicRoot = kind === 'public'
    ? await realpath(options.publicRoot).catch(() => {
      throw new ImageAssetError('The selected project image does not exist.', 404);
    })
    : options.publicRoot;
  const sourceFile = await realpath(path.resolve(projectRoot, options.sourceFile)).catch(() => {
    throw new ImageAssetError('The image source file no longer exists.', 404);
  });
  if (!isInsideProjectRoot(sourceRoot, sourceFile)) {
    throw new ImageAssetError('The image source file is outside the Astro source directory.', 403);
  }
  const candidate = kind === 'public'
    ? path.resolve(publicRoot, `.${reference}`)
    : path.resolve(path.dirname(sourceFile), reference);
  const allowedRoot = kind === 'public' ? publicRoot : sourceRoot;
  if (!isInsideProjectRoot(allowedRoot, candidate)) {
    throw new ImageAssetError('The image reference is outside its configured project directory.', 403);
  }
  const file = await realpath(candidate).catch(() => {
    throw new ImageAssetError('The selected project image does not exist.', 404);
  });
  if (!isInsideProjectRoot(allowedRoot, file)) {
    throw new ImageAssetError('The image reference is outside its configured project directory.', 403);
  }
  const handle = await open(file, 'r');
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > DEFAULT_IMAGE_MAX_BYTES) {
      throw new ImageAssetError('The selected project file is not a supported image.');
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (!imageType.matches(bytes)) {
    throw new ImageAssetError('The selected project file is not a supported image.');
  }
  return { bytes, contentType: imageType.mime, file, kind, reference };
}

function imageTypeFor(fileName: string): (typeof IMAGE_TYPES)[number] {
  const extension = path.extname(fileName).toLowerCase();
  const imageType = IMAGE_TYPES.find((type) => type.extensions.some((item) => item === extension));
  if (!imageType) throw new ImageAssetError('Choose a supported PNG, JPEG, GIF, or WebP image.');
  return imageType;
}

export function normalizeImageAssetDirectory(value: string): string {
  if (!value || value === '.' || path.isAbsolute(value) || value.includes('\\')) {
    throw new ImageAssetError('The image asset directory must be a relative path inside Astro public files.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new ImageAssetError('The image asset directory must be a relative path inside Astro public files.');
  }
  return segments.join('/');
}

function validateFileName(value: string): string {
  const fileName = value.trim();
  if (fileName.length > 120
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)
    || fileName.includes('..')) {
    throw new ImageAssetError('Use a file name with letters, numbers, dots, dashes, or underscores.');
  }
  return fileName;
}
