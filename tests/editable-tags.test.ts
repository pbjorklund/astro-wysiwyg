import assert from 'node:assert/strict';
import test from 'node:test';
import { EDITABLE_BLOCK_TAGS, MARKDOWN_EDITABLE_BLOCK_TAGS } from '../src/editable-tags.ts';

test('defines Markdown editable tags as a subset of the complete block policy', () => {
  assert.deepEqual(MARKDOWN_EDITABLE_BLOCK_TAGS, [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  ]);
  assert.deepEqual(EDITABLE_BLOCK_TAGS, [
    ...MARKDOWN_EDITABLE_BLOCK_TAGS,
    'figcaption', 'dt', 'dd', 'td', 'th', 'caption', 'legend', 'summary', 'button', 'label',
  ]);
});
