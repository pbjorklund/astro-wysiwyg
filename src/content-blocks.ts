export type ContentBlockId =
  | 'paragraph'
  | 'heading'
  | 'bulleted-list'
  | 'numbered-list'
  | 'blockquote'
  | 'code-block'
  | 'divider';

export type ContentBlockFormat = 'astro' | 'markdown';

export interface ContentBlockValue {
  text: string;
  items: string[];
}

export type ContentPickerIcon = 'image-plus' | 'link' | 'list' | 'list-ordered' | 'pilcrow' | 'plus' | 'type' | 'video';

export interface ContentBlockType {
  id: ContentBlockId;
  label: string;
  icon: ContentPickerIcon;
  tag: 'p' | 'h2' | 'ul' | 'ol' | 'blockquote' | 'pre' | 'hr';
  contexts: readonly ContentBlockFormat[];
  defaultValue: ContentBlockValue;
}

const EVERY_CONTEXT = ['astro', 'markdown'] as const;

export const CONTENT_BLOCK_TYPES: readonly ContentBlockType[] = Object.freeze([
  { id: 'paragraph', label: 'Paragraph', icon: 'pilcrow', tag: 'p', contexts: EVERY_CONTEXT, defaultValue: { text: 'New paragraph', items: [] } },
  { id: 'heading', label: 'Heading', icon: 'type', tag: 'h2', contexts: EVERY_CONTEXT, defaultValue: { text: 'New heading', items: [] } },
  { id: 'bulleted-list', label: 'Bulleted list', icon: 'list', tag: 'ul', contexts: EVERY_CONTEXT, defaultValue: { text: '', items: ['New item'] } },
  { id: 'numbered-list', label: 'Numbered list', icon: 'list-ordered', tag: 'ol', contexts: EVERY_CONTEXT, defaultValue: { text: '', items: ['New item'] } },
  { id: 'blockquote', label: 'Blockquote', icon: 'pilcrow', tag: 'blockquote', contexts: EVERY_CONTEXT, defaultValue: { text: 'New quote', items: [] } },
  { id: 'code-block', label: 'Code block', icon: 'type', tag: 'pre', contexts: EVERY_CONTEXT, defaultValue: { text: 'New code', items: [] } },
  { id: 'divider', label: 'Divider', icon: 'plus', tag: 'hr', contexts: EVERY_CONTEXT, defaultValue: { text: '', items: [] } },
]);

export const CONTENT_PICKER_ITEMS = Object.freeze([
  ...CONTENT_BLOCK_TYPES.map((type) => ({ ...type, kind: 'static' as const })),
  { id: 'image', label: 'Image', icon: 'image-plus' as const, kind: 'dialog' as const, action: 'open-image' },
  { id: 'video', label: 'Video', icon: 'video' as const, kind: 'dialog' as const, action: 'open-video' },
  { id: 'iframe', label: 'Iframe embed', icon: 'link' as const, kind: 'dialog' as const, action: 'open-iframe' },
]);

const TYPES_BY_ID = new Map(CONTENT_BLOCK_TYPES.map((type) => [type.id, type]));

export class ContentBlockError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function contentBlockTypesForFormat(format: ContentBlockFormat | 'frontmatter'): readonly ContentBlockType[] {
  if (format === 'frontmatter') throw new ContentBlockError('Frontmatter fields cannot contain static content blocks.');
  return CONTENT_BLOCK_TYPES.filter((type) => type.contexts.includes(format));
}

export function contentBlockType(id: ContentBlockId): ContentBlockType {
  const type = TYPES_BY_ID.get(id);
  if (!type) throw new ContentBlockError('That static content block is not supported.');
  return type;
}

export function contentBlockTypeFromTag(tag: string): ContentBlockType | undefined {
  const normalized = tag.toLowerCase();
  if (/^h[1-6]$/.test(normalized)) return TYPES_BY_ID.get('heading');
  return CONTENT_BLOCK_TYPES.find((type) => type.tag === normalized);
}

export function normalizeContentBlockValue(
  id: ContentBlockId,
  input?: { text: string; items: readonly string[] },
): ContentBlockValue {
  const type = contentBlockType(id);
  const value = input ?? type.defaultValue;
  if (typeof value.text !== 'string' || !Array.isArray(value.items)) {
    throw new ContentBlockError('The content block value is incomplete.');
  }
  let text = normalizeText(value.text, 10_000);
  let items = value.items.map((item) => normalizeText(item, 2_000));
  if (items.length > 100) throw new ContentBlockError('The content block has too many list items.');
  if (id === 'bulleted-list' || id === 'numbered-list') {
    if (!items.length && text) items = text.split('\n').map((item) => normalizeText(item, 2_000));
    if (!items.length || items.some((item) => !item)) {
      throw new ContentBlockError('At least one non-empty list item is required.');
    }
    return { text: '', items };
  }
  if (id === 'divider') return { text: '', items: [] };
  if (!text && items.length) text = items.join('\n');
  if (!text) throw new ContentBlockError('Content block text is required.');
  return { text, items: [] };
}

export function contentBlockTag(id: ContentBlockId, headingLevel = 2): ContentBlockType['tag'] | `h${1 | 2 | 3 | 4 | 5 | 6}` {
  const type = contentBlockType(id);
  if (id !== 'heading') return type.tag;
  if (!Number.isInteger(headingLevel) || headingLevel < 1 || headingLevel > 6) {
    throw new ContentBlockError('Heading level must be a whole number from 1 to 6.');
  }
  return `h${headingLevel}` as `h${1 | 2 | 3 | 4 | 5 | 6}`;
}

export function serializeContentBlock(
  id: ContentBlockId,
  format: ContentBlockFormat,
  input?: { text: string; items: readonly string[] },
  headingLevel = 2,
): string {
  const value = normalizeContentBlockValue(id, input);
  const tag = contentBlockTag(id, headingLevel);
  if (format === 'astro') return serializeAstro(id, value, tag);
  return serializeMarkdown(id, value, headingLevel);
}

export function replacementWarning(
  source: ContentBlockId,
  target: ContentBlockId,
  value: ContentBlockValue,
  sourceHasFormatting: boolean,
  sourceHasContent = Boolean(value.text || value.items.length),
): string | undefined {
  if (target === 'divider' && sourceHasContent) {
    return 'Replacing this block with a divider removes all content.';
  }
  if ((source === 'bulleted-list' || source === 'numbered-list') && target !== source) {
    return 'This replacement removes the current list structure.';
  }
  if (source === 'blockquote' && target !== source) {
    return 'This replacement removes the current blockquote structure.';
  }
  if (source === 'code-block' && target !== source) {
    return 'This replacement removes the current code-block structure.';
  }
  if (sourceHasFormatting && target !== source) {
    return 'This replacement converts inline formatting to plain text.';
  }
  if (target === 'heading' && (value.items.length > 1 || value.text.includes('\n'))) {
    return 'A heading must use one line, so line breaks will be joined.';
  }
  return undefined;
}

function normalizeText(value: string, maxLength: number): string {
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > maxLength) throw new ContentBlockError('The content block value is too long.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ContentBlockError('Content block values cannot contain control characters.');
  }
  return text;
}

function serializeAstro(id: ContentBlockId, value: ContentBlockValue, tag: string): string {
  if (id === 'divider') return '<hr />';
  if (id === 'bulleted-list' || id === 'numbered-list') {
    const tag = id === 'bulleted-list' ? 'ul' : 'ol';
    return `<${tag}>${value.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
  }
  if (id === 'blockquote') return `<blockquote><p>${astroLines(value.text)}</p></blockquote>`;
  if (id === 'code-block') return `<pre><code>${escapeHtml(value.text)}</code></pre>`;
  const content = id === 'heading' ? escapeHtml(oneLine(value.text)) : astroLines(value.text);
  return `<${tag}>${content}</${tag}>`;
}

function serializeMarkdown(id: ContentBlockId, value: ContentBlockValue, headingLevel: number): string {
  if (id === 'divider') return '---';
  if (id === 'bulleted-list') return value.items.map((item) => `- ${escapeMarkdown(item)}`).join('\n');
  if (id === 'numbered-list') return value.items.map((item, index) => `${index + 1}. ${escapeMarkdown(item)}`).join('\n');
  if (id === 'blockquote') return value.text.split('\n').map((line) => `> ${escapeMarkdown(line)}`).join('\n');
  if (id === 'code-block') {
    const longest = Math.max(0, ...[...value.text.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}\n${value.text}\n${fence}`;
  }
  if (id === 'heading') return `${'#'.repeat(headingLevel)} ${escapeMarkdown(oneLine(value.text))}`;
  return value.text.split('\n').map(escapeMarkdown).join('  \n');
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ');
}

function astroLines(value: string): string {
  return value.split('\n').map(escapeHtml).join('<br />');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]{}()<>#+\-.!|>])/g, '\\$1');
}
