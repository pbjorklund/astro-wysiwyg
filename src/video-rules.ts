export const VIDEO_ACCEPT = '.mp4';

export function videoUploadEndpoint(endpoint: string): string {
  const normalized = endpoint.length > 1 && endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  return `${normalized}/videos`;
}

export function suggestVideoFilename(originalName: string): string {
  const extension = originalName.trim().toLowerCase().endsWith('.mp4') ? '.mp4' : '';
  const stem = originalName.trim().slice(0, extension ? -extension.length : undefined)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `${stem || 'video'}.mp4`;
}
