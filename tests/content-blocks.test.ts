import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTENT_BLOCK_TYPES,
  CONTENT_PICKER_ITEMS,
  contentBlockTypeFromTag,
  contentBlockTypesForFormat,
  normalizeContentBlockValue,
  replacementWarning,
  serializeContentBlock,
} from '../src/content-blocks.ts';

test('defines one stable context-aware registry for every supported static block', () => {
  assert.deepEqual(CONTENT_BLOCK_TYPES.map(({ id, label }) => [id, label]), [
    ['paragraph', 'Paragraph'], ['heading', 'Heading'], ['bulleted-list', 'Bulleted list'],
    ['numbered-list', 'Numbered list'], ['blockquote', 'Blockquote'], ['code-block', 'Code block'],
    ['divider', 'Divider'],
  ]);
  assert.deepEqual(contentBlockTypesForFormat('astro').map(({ id }) => id), CONTENT_BLOCK_TYPES.map(({ id }) => id));
  assert.deepEqual(contentBlockTypesForFormat('markdown').map(({ id }) => id), CONTENT_BLOCK_TYPES.map(({ id }) => id));
  assert.equal(contentBlockTypeFromTag('h6')?.id, 'heading');
  assert.equal(contentBlockTypeFromTag('pre')?.id, 'code-block');
  assert.equal(contentBlockTypeFromTag('hr')?.id, 'divider');
  assert.equal(contentBlockTypeFromTag('section'), undefined);
  assert.deepEqual(CONTENT_PICKER_ITEMS.slice(-3).map(({ id, kind }) => [id, kind]), [
    ['image', 'dialog'], ['video', 'dialog'], ['iframe', 'dialog'],
  ]);
  assert.throws(() => contentBlockTypesForFormat('frontmatter'), /content blocks/i);
});

test('normalizes bounded plain text and list values with explicit defaults', () => {
  assert.deepEqual(normalizeContentBlockValue('paragraph'), { text: 'New paragraph', items: [] });
  assert.deepEqual(normalizeContentBlockValue('bulleted-list'), { text: '', items: ['New item'] });
  assert.deepEqual(normalizeContentBlockValue('divider'), { text: '', items: [] });
  assert.deepEqual(normalizeContentBlockValue('paragraph', { text: '  Kept text  ', items: [] }), { text: 'Kept text', items: [] });
  assert.deepEqual(normalizeContentBlockValue('numbered-list', { text: '', items: [' One ', 'Two'] }), { text: '', items: ['One', 'Two'] });
  assert.deepEqual(normalizeContentBlockValue('bulleted-list', { text: 'One\nTwo', items: [] }), { text: '', items: ['One', 'Two'] });
  assert.throws(() => normalizeContentBlockValue('paragraph', { text: 'x', items: 'bad' } as never), /incomplete/i);
  assert.throws(() => normalizeContentBlockValue('paragraph', { text: '', items: [] }), /text is required/i);
  assert.throws(() => normalizeContentBlockValue('bulleted-list', { text: '', items: [] }), /list item/i);
  assert.throws(() => normalizeContentBlockValue('paragraph', { text: 'x'.repeat(10_001), items: [] }), /too long/i);
  assert.throws(() => normalizeContentBlockValue('paragraph', { text: 'bad\u0000text', items: [] }), /control/i);
  assert.throws(() => normalizeContentBlockValue('bulleted-list', { text: '', items: Array(101).fill('item') }), /too many/i);
  assert.throws(() => normalizeContentBlockValue('bulleted-list', { text: '', items: [''] }), /list item/i);
  assert.throws(() => normalizeContentBlockValue('missing' as never), /not supported/i);
});

test('serializes each type as portable Astro and Markdown source', () => {
  const values = {
    paragraph: { text: 'Alpha & <beta>', items: [] },
    heading: { text: 'Release notes', items: [] },
    'bulleted-list': { text: '', items: ['First', 'Second'] },
    'numbered-list': { text: '', items: ['First', 'Second'] },
    blockquote: { text: 'Quoted\ntext', items: [] },
    'code-block': { text: 'const value = `x`;\n```', items: [] },
    divider: { text: '', items: [] },
  } as const;
  assert.equal(serializeContentBlock('paragraph', 'astro', values.paragraph), '<p>Alpha &amp; &lt;beta&gt;</p>');
  assert.equal(serializeContentBlock('heading', 'astro', values.heading), '<h2>Release notes</h2>');
  assert.equal(serializeContentBlock('heading', 'astro', values.heading, 6), '<h6>Release notes</h6>');
  assert.equal(serializeContentBlock('bulleted-list', 'astro', values['bulleted-list']), '<ul><li>First</li><li>Second</li></ul>');
  assert.equal(serializeContentBlock('numbered-list', 'astro', values['numbered-list']), '<ol><li>First</li><li>Second</li></ol>');
  assert.equal(serializeContentBlock('blockquote', 'astro', values.blockquote), '<blockquote><p>Quoted<br />text</p></blockquote>');
  assert.equal(serializeContentBlock('code-block', 'astro', values['code-block']), '<pre><code>const value = `x`;\n```</code></pre>');
  assert.equal(serializeContentBlock('divider', 'astro', values.divider), '<hr />');

  assert.equal(serializeContentBlock('paragraph', 'markdown', values.paragraph), 'Alpha & \\<beta\\>');
  assert.equal(serializeContentBlock('heading', 'markdown', values.heading), '## Release notes');
  assert.equal(serializeContentBlock('heading', 'markdown', values.heading, 1), '# Release notes');
  assert.throws(() => serializeContentBlock('heading', 'markdown', values.heading, 7), /Heading level/);
  assert.equal(serializeContentBlock('bulleted-list', 'markdown', values['bulleted-list']), '- First\n- Second');
  assert.equal(serializeContentBlock('numbered-list', 'markdown', values['numbered-list']), '1. First\n2. Second');
  assert.equal(serializeContentBlock('blockquote', 'markdown', values.blockquote), '> Quoted\n> text');
  assert.equal(serializeContentBlock('code-block', 'markdown', values['code-block']), '````\nconst value = `x`;\n```\n````');
  assert.equal(serializeContentBlock('divider', 'markdown', values.divider), '---');
});

test('predicts structure, formatting, multiline heading, and content-loss warnings', () => {
  const text = { text: 'Text', items: [] };
  assert.equal(replacementWarning('paragraph', 'heading', text, false), undefined);
  assert.match(replacementWarning('paragraph', 'heading', { text: 'One\nTwo', items: [] }, false)!, /one line/i);
  assert.match(replacementWarning('paragraph', 'code-block', text, true)!, /formatting/i);
  assert.match(replacementWarning('bulleted-list', 'paragraph', { text: '', items: ['One', 'Two'] }, false)!, /list structure/i);
  assert.match(replacementWarning('blockquote', 'paragraph', text, false)!, /blockquote structure/i);
  assert.match(replacementWarning('code-block', 'paragraph', text, false)!, /code-block structure/i);
  assert.match(replacementWarning('paragraph', 'divider', text, false)!, /removes all content/i);
  assert.equal(replacementWarning('divider', 'paragraph', { text: '', items: [] }, false), undefined);
});
