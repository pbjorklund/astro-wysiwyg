export function imageUploadEndpoint(endpoint: string): string {
  return `${endpoint === '/' ? '' : endpoint}/assets`;
}

export function suggestImageFilename(original: string): string {
  const trimmed = original.trim();
  const dot = trimmed.lastIndexOf('.');
  const extension = dot > 0 ? trimmed.slice(dot).toLowerCase() : '';
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  const safeStem = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'image';
  return `${safeStem}${extension}`;
}
