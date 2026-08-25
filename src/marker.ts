export type EditableFormat = 'astro' | 'frontmatter' | 'markdown';

export interface SourceMarker {
  version: 1;
  file: string;
  start: number;
  end: number;
  original: string;
  format: EditableFormat;
  tag: string;
  field?: string;
}

export function createMarker(
  file: string,
  start: number,
  end: number,
  original: string,
  format: EditableFormat,
  tag: string,
): SourceMarker {
  return { version: 1, file, start, end, original, format, tag };
}

export function encodeMarker(marker: SourceMarker): string {
  return Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url');
}

export function decodeMarker(token: string): SourceMarker {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('The editor marker is malformed. Reload the page and try again.');
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('The editor marker is malformed. Reload the page and try again.');
  }

  if (!isSourceMarker(value)) {
    throw new Error('The editor marker is invalid. Reload the page and try again.');
  }
  return value;
}

function isSourceMarker(value: unknown): value is SourceMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Record<string, unknown>;
  return marker.version === 1
    && typeof marker.file === 'string'
    && Number.isSafeInteger(marker.start)
    && Number.isSafeInteger(marker.end)
    && Number(marker.start) >= 0
    && Number(marker.end) >= Number(marker.start)
    && typeof marker.original === 'string'
    && (marker.format === 'astro' || marker.format === 'frontmatter' || marker.format === 'markdown')
    && typeof marker.tag === 'string'
    && (marker.field === undefined || typeof marker.field === 'string');
}
