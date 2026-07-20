import type { IframeFields } from './iframe-rules.ts';

const SUPPORTED_ATTRIBUTES = new Set([
  'src', 'title', 'width', 'height', 'loading', 'referrerpolicy', 'allow', 'sandbox', 'allowfullscreen',
]);

export type SourceIframe = IframeFields;

interface Attribute {
  name: string;
  value?: string;
}

export function inspectSourceIframe(source: string): SourceIframe | undefined {
  const match = /^\s*<iframe\b([\s\S]*?)>\s*<\/iframe>\s*$/i.exec(source);
  if (!match || /[{}]/.test(match[1])) return undefined;
  const attributes = parseAttributes(match[1]);
  if (!attributes || [...attributes.keys()].some((name) => !SUPPORTED_ATTRIBUTES.has(name))) return undefined;
  const src = attributes.get('src')?.value;
  const title = attributes.get('title')?.value;
  const width = Number(attributes.get('width')?.value);
  const height = Number(attributes.get('height')?.value);
  const loading = attributes.get('loading')?.value;
  const referrerPolicy = attributes.get('referrerpolicy')?.value;
  const allowValue = attributes.get('allow')?.value ?? '';
  const sandboxValue = attributes.get('sandbox')?.value;
  if (!src || !title || !Number.isInteger(width) || !Number.isInteger(height)
    || (loading !== 'lazy' && loading !== 'eager')
    || !['no-referrer', 'origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'].includes(referrerPolicy ?? '')
    || sandboxValue === undefined) return undefined;
  if (!isSafeSourceSyntax(src)) return undefined;
  const allow = splitTokens(allowValue, ';');
  const sandbox = splitTokens(sandboxValue, ' ');
  if (!allow || !sandbox) return undefined;
  const fullscreen = attributes.get('allowfullscreen');
  if (fullscreen?.value !== undefined) return undefined;
  return {
    src,
    title,
    width,
    height,
    loading,
    referrerPolicy: referrerPolicy as SourceIframe['referrerPolicy'],
    allow,
    sandbox,
    allowFullscreen: attributes.has('allowfullscreen'),
  };
}

export function serializeIframe(fields: IframeFields): string {
  const attributes = [
    `src="${escapeAttribute(fields.src)}"`,
    `title="${escapeAttribute(fields.title)}"`,
    `width="${fields.width}"`,
    `height="${fields.height}"`,
    `loading="${fields.loading}"`,
    `referrerpolicy="${fields.referrerPolicy}"`,
    `sandbox="${fields.sandbox.join(' ')}"`,
  ];
  if (fields.allow.length) attributes.push(`allow="${fields.allow.join('; ')}"`);
  if (fields.allowFullscreen) attributes.push('allowfullscreen');
  return `<iframe ${attributes.join(' ')}></iframe>`;
}

export function addIframeMarkerAttributes(source: string, marker: string): string | undefined {
  if (!inspectSourceIframe(source)) return undefined;
  return source.replace(/<iframe\b/i, `<iframe data-astro-wysiwyg="${marker}" data-astro-wysiwyg-iframe`);
}

function parseAttributes(value: string): Map<string, Attribute> | undefined {
  const attributes = new Map<string, Attribute>();
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index])) index += 1;
    if (index >= value.length) return attributes;
    const match = /^[A-Za-z][A-Za-z0-9_-]*/.exec(value.slice(index));
    if (!match) return undefined;
    const name = match[0].toLowerCase();
    if (attributes.has(name)) return undefined;
    index += match[0].length;
    while (/\s/.test(value[index] ?? '')) index += 1;
    let attributeValue: string | undefined;
    if (value[index] === '=') {
      index += 1;
      while (/\s/.test(value[index] ?? '')) index += 1;
      const quote = value[index];
      if (quote !== '"' && quote !== "'") return undefined;
      const start = ++index;
      while (index < value.length && value[index] !== quote) index += 1;
      if (value[index] !== quote) return undefined;
      attributeValue = value.slice(start, index);
      index += 1;
    }
    attributes.set(name, { name, value: attributeValue });
  }
  return attributes;
}

function splitTokens(value: string, separator: ';' | ' '): string[] | undefined {
  const tokens = value.split(separator).map((token) => token.trim()).filter(Boolean);
  return tokens.every((token) => /^[a-z][a-z-]*$/.test(token)) ? tokens : undefined;
}

function isSafeSourceSyntax(value: string): boolean {
  if (/^\/(?!\/)[A-Za-z0-9._/-]*$/.test(value)) return !value.split('/').includes('..');
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
