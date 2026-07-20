export const MARKDOWN_EDITABLE_BLOCK_TAGS: readonly string[] = Object.freeze([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr',
]);

export const EDITABLE_BLOCK_TAGS: readonly string[] = Object.freeze([
  ...MARKDOWN_EDITABLE_BLOCK_TAGS,
  'figcaption', 'dt', 'dd', 'td', 'th', 'caption', 'legend', 'summary', 'button', 'label',
]);
