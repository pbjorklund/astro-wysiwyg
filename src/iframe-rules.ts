export const IFRAME_LOADING_VALUES = ['lazy', 'eager'] as const;
export const IFRAME_REFERRER_POLICIES = [
  'no-referrer',
  'origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
] as const;
export const IFRAME_ALLOW_TOKENS = [
  'autoplay', 'clipboard-write', 'encrypted-media', 'fullscreen', 'picture-in-picture',
] as const;
export const IFRAME_SANDBOX_TOKENS = [
  'allow-forms', 'allow-modals', 'allow-popups', 'allow-presentation', 'allow-same-origin', 'allow-scripts',
] as const;

export interface IframeFields {
  src: string;
  title: string;
  width: number;
  height: number;
  loading: (typeof IFRAME_LOADING_VALUES)[number];
  referrerPolicy: (typeof IFRAME_REFERRER_POLICIES)[number];
  allow: string[];
  sandbox: string[];
  allowFullscreen: boolean;
}

export class IframeRuleError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function normalizeIframeOrigins(values: string[] = ['self']): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new IframeRuleError('Configure at least one iframe origin or "self".');
  }
  const normalized = values.map((value) => {
    const candidate = value.trim();
    if (candidate === 'self') return candidate;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new IframeRuleError('Iframe origins must be "self" or exact HTTPS origins.');
    }
    if (url.protocol !== 'https:' || url.origin !== candidate || url.username || url.password) {
      throw new IframeRuleError('Iframe origins must be "self" or exact HTTPS origins.');
    }
    return url.origin;
  });
  return [...new Set(normalized)];
}

export function validateIframeFields(fields: IframeFields, origins: readonly string[]): IframeFields {
  const src = validateIframeUrl(fields.src, origins);
  const title = fields.title.trim();
  if (!title || title.length > 300 || hasControlCharacters(title)) {
    throw new IframeRuleError('Give the iframe an accessible title.');
  }
  const width = validateDimension(fields.width, 'width');
  const height = validateDimension(fields.height, 'height');
  if (!IFRAME_LOADING_VALUES.includes(fields.loading)) {
    throw new IframeRuleError('Choose lazy or eager iframe loading.');
  }
  if (!IFRAME_REFERRER_POLICIES.includes(fields.referrerPolicy)) {
    throw new IframeRuleError('Choose a supported iframe referrer policy.');
  }
  const allow = validateTokens(fields.allow, IFRAME_ALLOW_TOKENS, 'iframe permission');
  const sandbox = validateTokens(fields.sandbox, IFRAME_SANDBOX_TOKENS, 'iframe sandbox');
  if (src.startsWith('/') && sandbox.includes('allow-scripts') && sandbox.includes('allow-same-origin')) {
    throw new IframeRuleError('Same-origin iframes cannot combine allow-scripts with allow-same-origin.');
  }
  return {
    src,
    title,
    width,
    height,
    loading: fields.loading,
    referrerPolicy: fields.referrerPolicy,
    allow,
    sandbox,
    allowFullscreen: fields.allowFullscreen,
  };
}

export function validateIframeUrl(value: string, origins: readonly string[]): string {
  const src = value.trim();
  if (!src || src.length > 2_000 || hasControlCharacters(src) || /[\\\s]/.test(src)) {
    throw new IframeRuleError('Choose a valid iframe URL.');
  }
  if (src.startsWith('/') && !src.startsWith('//')) {
    if (!origins.includes('self') || !/^\/(?!\/)[A-Za-z0-9._/-]*$/.test(src)
      || src.split('/').includes('..')) {
      throw new IframeRuleError('This same-origin iframe URL is not approved.');
    }
    return src;
  }
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new IframeRuleError('Choose a valid iframe URL.');
  }
  if (url.protocol !== 'https:' || !origins.includes(url.origin) || url.username || url.password) {
    throw new IframeRuleError('This iframe provider is not approved.');
  }
  return url.href;
}

function validateDimension(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 4_096) {
    throw new IframeRuleError(`Iframe ${name} must be a whole number from 1 to 4096.`);
  }
  return value;
}

function validateTokens(
  values: string[],
  allowed: readonly string[],
  name: string,
): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new IframeRuleError(`Choose supported ${name} settings.`);
  }
  const unique = [...new Set(values)];
  if (unique.some((value) => !allowed.includes(value))) {
    throw new IframeRuleError(`Choose supported ${name} settings.`);
  }
  return allowed.filter((value) => unique.includes(value));
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
