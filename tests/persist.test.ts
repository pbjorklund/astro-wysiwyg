import assert from 'node:assert/strict';
import { chmod, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applySourceEdit,
  applySourceContentBlockEdit,
  applySourceImageInsert,
  applySourceIframeInsert,
  applySourceIframeReplacement,
  applySourceImageReplacement,
  applySourceStructureEdit,
  applySourceVideoInsert,
  applySourceVideoReplacement,
} from '../src/persist.ts';
import { createMarker, decodeMarker, encodeMarker } from '../src/marker.ts';

async function fixture(source: string, extension = '.md') {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-'));
  const file = path.join(root, `page${extension}`);
  await writeFile(file, source);
  return { root: await realpath(root), file };
}

test('marker encoding is URL and HTML attribute safe', () => {
  const token = encodeMarker(createMarker('src/page.md', 4, 12, '**hello**', 'markdown', 'p'));
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeMarker(token), {
    version: 1,
    file: 'src/page.md',
    start: 4,
    end: 12,
    original: '**hello**',
    format: 'markdown',
    tag: 'p',
  });
});

test('rejects malformed and invalid editor markers', () => {
  assert.throws(() => decodeMarker('not+base64'), /malformed/);
  assert.throws(() => decodeMarker(Buffer.from('{').toString('base64url')), /malformed/);

  const valid = createMarker('page.md', 0, 4, 'text', 'markdown', 'p');
  const invalid = [
    null,
    { ...valid, version: 2 },
    { ...valid, file: 1 },
    { ...valid, start: -1 },
    { ...valid, start: 0.5 },
    { ...valid, end: -1 },
    { ...valid, end: 0.5 },
    { ...valid, start: 5, end: 4 },
    { ...valid, original: 1 },
    { ...valid, format: 'html' },
    { ...valid, tag: 1 },
  ];
  for (const marker of invalid) {
    const token = Buffer.from(JSON.stringify(marker)).toString('base64url');
    assert.throws(() => decodeMarker(token), /invalid/);
  }
});

test('accepts every supported marker format', () => {
  for (const format of ['astro', 'frontmatter', 'markdown'] as const) {
    const marker = createMarker('page.md', 0, 0, '', format, 'p');
    assert.equal(decodeMarker(encodeMarker(marker)).format, format);
  }
});

test('saves rich HTML as Markdown while preserving surrounding source', async (t) => {
  const source = 'Before\n\nOld text\n\nAfter\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('Old text');
  const token = encodeMarker(createMarker('page.md', start, start + 8, 'Old text', 'markdown', 'p'));

  let beforeWriteFile = '';
  const result = await applySourceEdit(root, {
    marker: token,
    html: 'New <strong>bold</strong> and <em>italic</em> text',
  }, (target) => { beforeWriteFile = target; });

  assert.equal(beforeWriteFile, file);
  assert.equal(await readFile(file, 'utf8'), 'Before\n\nNew **bold** and _italic_ text\n\nAfter\n');
  assert.equal(decodeMarker(result.marker).original, 'New **bold** and _italic_ text');
});

test('atomically replaces source files without changing an open reader', async (t) => {
  const source = 'Old text\n';
  const { root, file } = await fixture(source);
  await chmod(file, 0o664);
  const reader = await open(file, 'r');
  t.after(async () => {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  });

  await applySourceEdit(root, {
    marker: encodeMarker(createMarker('page.md', 0, 8, 'Old text', 'markdown', 'p')),
    html: 'New text',
  });

  assert.equal(await reader.readFile('utf8'), source);
  assert.equal(await readFile(file, 'utf8'), 'New text\n');
  assert.equal((await stat(file)).mode & 0o777, 0o664);
});

test('serializes overlapping edits to the same source file', async (t) => {
  const source = 'First\n\nSecond\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const secondStart = source.indexOf('Second');
  let releaseSecondRead!: () => void;
  const secondRead = new Promise<void>((resolve) => { releaseSecondRead = resolve; });

  const first = applySourceEdit(root, {
    marker: encodeMarker(createMarker('page.md', 0, 5, 'First', 'markdown', 'p')),
    html: 'Updated first',
  }, async () => {
    await Promise.race([
      secondRead,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const second = applySourceEdit(root, {
    marker: encodeMarker(createMarker(
      'page.md', secondStart, secondStart + 6, 'Second', 'markdown', 'p',
    )),
    html: 'Updated second',
  }, releaseSecondRead);

  await Promise.all([first, second]);

  assert.equal(await readFile(file, 'utf8'), 'Updated first\n\nUpdated second\n');
});

test('keeps editor-entered expression delimiters literal in Astro and MDX', async (t) => {
  const astro = await fixture('<p>Old</p>\n', '.astro');
  const mdx = await fixture('Old\n', '.mdx');
  const markdown = await fixture('Old\n');
  t.after(() => Promise.all([
    rm(astro.root, { recursive: true, force: true }),
    rm(mdx.root, { recursive: true, force: true }),
    rm(markdown.root, { recursive: true, force: true }),
  ]));

  await applySourceEdit(astro.root, {
    marker: encodeMarker(createMarker('page.astro', 0, 10, '<p>Old</p>', 'astro', 'p')),
    html: 'Hello {secret} and <code>{sample}</code><span title="{attribute}" data-label=\'{label}\'>{text}</span>',
  });
  await applySourceEdit(mdx.root, {
    marker: encodeMarker(createMarker('page.mdx', 0, 3, 'Old', 'markdown', 'p')),
    html: 'Hello {secret} and <code>{sample}</code><pre><code>{fenced}\n}</code></pre>After <code>``{ticks}``</code>, <code>a`b``c</code>, and unmatched ` {tail}',
  });
  await applySourceEdit(markdown.root, {
    marker: encodeMarker(createMarker('page.md', 0, 3, 'Old', 'markdown', 'p')),
    html: 'Hello {name}',
  });

  assert.equal(
    await readFile(astro.file, 'utf8'),
    '<p>Hello &#123;secret&#125; and <code>&#123;sample&#125;</code><span title="{attribute}" data-label="{label}">&#123;text&#125;</span></p>\n',
  );
  assert.equal(
    await readFile(mdx.file, 'utf8'),
    'Hello &#123;secret&#125; and `{sample}`\n\n```\n{fenced}\n}\n```\n\nAfter ` ``{ticks}`` `, ```a`b``c```, and unmatched \\` &#123;tail&#125;\n',
  );
  assert.equal(await readFile(markdown.file, 'utf8'), 'Hello {name}\n');
});

test('sanitizes pasted HTML before writing deployable source', async (t) => {
  const astro = await fixture('<p>Old</p>\n', '.astro');
  const markdown = await fixture('Old\n');
  t.after(() => Promise.all([
    rm(astro.root, { recursive: true, force: true }),
    rm(markdown.root, { recursive: true, force: true }),
  ]));
  const pasted = '<a href="javascript:alert(1)" onclick="alert(2)">bad</a> <a href="/safe" class="link" data-id="1">safe</a> <strong style="color:red" onmouseover="alert(3)">bold</strong><img src="x" onerror="alert(4)"><script>alert(5)</script>';

  await applySourceEdit(astro.root, {
    marker: encodeMarker(createMarker('page.astro', 0, 10, '<p>Old</p>', 'astro', 'p')),
    html: pasted,
  });
  await applySourceEdit(markdown.root, {
    marker: encodeMarker(createMarker('page.md', 0, 3, 'Old', 'markdown', 'p')),
    html: pasted,
  });

  const astroSource = await readFile(astro.file, 'utf8');
  assert.equal(
    astroSource,
    '<p><a>bad</a> <a href="/safe" class="link" data-id="1">safe</a> <strong>bold</strong></p>\n',
  );
  assert.equal(await readFile(markdown.file, 'utf8'), 'bad [safe](/safe) **bold**\n');
});

test('keeps marker coordinates stable when rendered positions exclude frontmatter', async (t) => {
  const source = '---\ntitle: Example\n---\nBody text\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 9, 'Body text', 'markdown', 'p'));

  const result = await applySourceEdit(root, { marker: token, html: 'Changed body' });

  assert.equal(await readFile(file, 'utf8'), '---\ntitle: Example\n---\nChanged body\n');
  assert.equal(decodeMarker(result.marker).start, 0);
});

test('inserts every registered static content block in Astro, Markdown, and MDX', async (t) => {
  const types = [
    ['paragraph', 'New paragraph'], ['heading', '## New heading'], ['bulleted-list', '- New item'],
    ['numbered-list', '1. New item'], ['blockquote', '> New quote'], ['code-block', '```\nNew code\n```'],
    ['divider', '---'],
  ] as const;
  for (const extension of ['.astro', '.md', '.mdx'] as const) {
    for (const [type, markdown] of types) {
      const astro = extension === '.astro';
      const source = astro ? '<p>Before</p>\n' : 'Before\n';
      const current = await fixture(source, extension);
      t.after(() => rm(current.root, { recursive: true, force: true }));
      const original = astro ? '<p>Before</p>' : 'Before';
      const result = await applySourceContentBlockEdit(current.root, {
        marker: encodeMarker(createMarker(`page${extension}`, 0, original.length, original, astro ? 'astro' : 'markdown', 'p')),
        operation: 'insert-content-after', type,
      });
      const inserted = decodeMarker(result.marker).original;
      assert.equal(inserted, astro ? ({
        paragraph: '<p>New paragraph</p>', heading: '<h2>New heading</h2>',
        'bulleted-list': '<ul><li>New item</li></ul>', 'numbered-list': '<ol><li>New item</li></ol>',
        blockquote: '<blockquote><p>New quote</p></blockquote>', 'code-block': '<pre><code>New code</code></pre>', divider: '<hr />',
      } as const)[type] : markdown);
      assert.match(await readFile(current.file, 'utf8'), new RegExp(inserted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});

test('replaces static blocks with plain structured values and requires predicted loss confirmation', async (t) => {
  const original = '- **One**\n- Two';
  const { root, file } = await fixture(`${original}\nAfter\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = encodeMarker(createMarker('page.md', 0, original.length, original, 'markdown', 'ul'));
  const edit = {
    marker, operation: 'replace-content' as const, type: 'paragraph' as const,
    value: { text: '', items: ['One', 'Two'] },
  };
  await assert.rejects(applySourceContentBlockEdit(root, edit), /Confirm.*list structure/i);
  assert.equal(await readFile(file, 'utf8'), `${original}\nAfter\n`);
  const result = await applySourceContentBlockEdit(root, { ...edit, confirmedLoss: true });
  assert.equal(await readFile(file, 'utf8'), 'One  \nTwo\nAfter\n');
  assert.equal(decodeMarker(result.marker).tag, 'p');

  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: result.marker, operation: 'replace-content', type: 'divider',
    value: { text: 'One\nTwo', items: [] },
  }), /removes all content/i);
  await applySourceContentBlockEdit(root, {
    marker: result.marker, operation: 'replace-content', type: 'divider',
    value: { text: 'One\nTwo', items: [] }, confirmedLoss: true,
  });
  assert.equal(await readFile(file, 'utf8'), '---\nAfter\n');
});

test('restores formatted block source and heading levels through structured undo values', async (t) => {
  const original = '<h6><strong>Release</strong> notes</h6>';
  const { root, file } = await fixture(`${original}\n`, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = encodeMarker(createMarker('page.astro', 0, original.length, original, 'astro', 'h6'));
  const replaced = await applySourceContentBlockEdit(root, {
    marker, operation: 'replace-content', type: 'divider',
    value: { text: 'Release notes', items: [] }, confirmedLoss: true,
  });
  assert.equal(await readFile(file, 'utf8'), '<hr />\n');
  await applySourceContentBlockEdit(root, {
    marker: replaced.marker, operation: 'replace-content', type: 'heading', headingLevel: 6,
    value: { text: 'Release notes', items: [] }, html: '<strong>Release</strong> notes', confirmedLoss: true,
  });
  assert.equal(await readFile(file, 'utf8'), `${original}\n`);

  const markdown = await fixture('```text\nconst value = true;\n```\n');
  t.after(() => rm(markdown.root, { recursive: true, force: true }));
  const codeOriginal = '```text\nconst value = true;\n```';
  const codeMarker = encodeMarker(createMarker('page.md', 0, codeOriginal.length, codeOriginal, 'markdown', 'pre'));
  const paragraph = await applySourceContentBlockEdit(markdown.root, {
    marker: codeMarker, operation: 'replace-content', type: 'paragraph',
    value: { text: 'const value = true;', items: [] }, confirmedLoss: true,
  });
  await applySourceContentBlockEdit(markdown.root, {
    marker: paragraph.marker, operation: 'replace-content', type: 'code-block', codeLanguage: 'text',
    value: { text: 'const value = true;', items: [] }, html: '<code>const value = true;</code>', confirmedLoss: true,
  });
  assert.equal(await readFile(markdown.file, 'utf8'), `${codeOriginal}\n`);

  const restored = await fixture('Plain\n');
  t.after(() => rm(restored.root, { recursive: true, force: true }));
  let restoredMarker = encodeMarker(createMarker('page.md', 0, 5, 'Plain', 'markdown', 'p'));
  let restoredResult = await applySourceContentBlockEdit(restored.root, {
    marker: restoredMarker, operation: 'replace-content', type: 'blockquote',
    value: { text: 'Quote', items: [] }, html: '<p><strong>Quote</strong></p>', confirmedLoss: true,
  });
  assert.equal(await readFile(restored.file, 'utf8'), '> **Quote**\n');
  restoredMarker = restoredResult.marker;
  restoredResult = await applySourceContentBlockEdit(restored.root, {
    marker: restoredMarker, operation: 'replace-content', type: 'code-block',
    value: { text: 'Quote', items: [] }, html: '<code>Quote</code>', confirmedLoss: true,
  });
  assert.equal(await readFile(restored.file, 'utf8'), '```\nQuote\n```\n');
  await applySourceContentBlockEdit(restored.root, {
    marker: restoredResult.marker, operation: 'replace-content', type: 'divider',
    value: { text: 'Quote', items: [] }, html: '', confirmedLoss: true,
  });
  assert.equal(await readFile(restored.file, 'utf8'), '---\n');

  const astroQuote = '<blockquote><p><em>Astro quote</em></p></blockquote>';
  const astro = await fixture(`${astroQuote}\n`, '.astro');
  t.after(() => rm(astro.root, { recursive: true, force: true }));
  const astroMarker = encodeMarker(createMarker('page.astro', 0, astroQuote.length, astroQuote, 'astro', 'blockquote'));
  const astroParagraph = await applySourceContentBlockEdit(astro.root, {
    marker: astroMarker, operation: 'replace-content', type: 'paragraph',
    value: { text: 'Astro quote', items: [] }, confirmedLoss: true,
  });
  await applySourceContentBlockEdit(astro.root, {
    marker: astroParagraph.marker, operation: 'replace-content', type: 'divider',
    value: { text: 'Astro quote', items: [] }, html: '', confirmedLoss: true,
  });
  assert.equal(await readFile(astro.file, 'utf8'), '<hr />\n');

  const generic = await fixture('```\nold\n```\n---\n');
  t.after(() => rm(generic.root, { recursive: true, force: true }));
  const genericCode = '```\nold\n```';
  await applySourceEdit(generic.root, {
    marker: encodeMarker(createMarker('page.md', 0, genericCode.length, genericCode, 'markdown', 'pre')),
    html: '<code>new</code>', tag: 'pre',
  });
  const dividerStart = (await readFile(generic.file, 'utf8')).indexOf('---');
  await applySourceEdit(generic.root, {
    marker: encodeMarker(createMarker('page.md', dividerStart, dividerStart + 3, '---', 'markdown', 'hr')),
    html: '', tag: 'hr',
  });
  assert.equal(await readFile(generic.file, 'utf8'), '```\nnew\n```\n---\n');
});

test('rejects invalid, unsupported, frontmatter, and conflicting static block edits atomically', async (t) => {
  const { root, file } = await fixture('Before\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p'));
  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: base, operation: 'insert-content-after', type: 'paragraph',
    value: { text: '', items: [] },
  }), /text is required/i);
  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: base, operation: 'insert-content-after', type: 'heading', headingLevel: 7,
  }), /Heading level/i);
  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: base, operation: 'replace-content', type: 'code-block', codeLanguage: 'bad language',
    value: { text: 'code', items: [] }, html: '<code>code</code>', confirmedLoss: true,
  }), /language is invalid/i);
  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Before', 'frontmatter', 'p')),
    operation: 'insert-content-after', type: 'paragraph',
  }), /Frontmatter/i);
  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Stale!', 'markdown', 'p')),
    operation: 'replace-content', type: 'heading', value: { text: 'Before', items: [] },
  }), /source changed/i);
  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: base, operation: 'replace-content', type: 'paragraph',
    value: { text: 'Before', items: [] },
  }), /different content block type/i);
  await assert.rejects(applySourceContentBlockEdit(root, {
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'section')),
    operation: 'replace-content', type: 'heading', value: { text: 'Before', items: [] },
  }), /cannot be replaced safely/i);
  assert.equal(await readFile(file, 'utf8'), 'Before\n');

  const crlf = await fixture('Before\r\n');
  t.after(() => rm(crlf.root, { recursive: true, force: true }));
  await applySourceContentBlockEdit(crlf.root, {
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p')),
    operation: 'insert-content-after', type: 'divider',
  });
  assert.equal(await readFile(crlf.file, 'utf8'), 'Before\r\n\r\n---\r\n');
});

test('adds a Markdown paragraph after the selected block', async (t) => {
  const source = 'First block\n\nSecond block\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'First block', 'markdown', 'p'));

  const result = await applySourceStructureEdit(root, { marker: token, operation: 'insert-after' });

  assert.equal(await readFile(file, 'utf8'), 'First block\n\nNew paragraph\n\nSecond block\n');
  assert.equal(decodeMarker(result.marker!).original, 'New paragraph');
  assert.equal(decodeMarker(result.marker!).start, 13);
});

test('inserts portable image syntax after Astro, Markdown, and MDX blocks', async (t) => {
  const markdown = await fixture('Before\n\nAfter\n');
  const mdx = await fixture('Before\n\nAfter\n', '.mdx');
  const crlf = await fixture('Before\r\n\r\nAfter\r\n');
  const astro = await fixture('<main>\n  <p>Before</p>\n  <p>After</p>\n</main>\n', '.astro');
  t.after(() => Promise.all([
    rm(markdown.root, { recursive: true, force: true }),
    rm(mdx.root, { recursive: true, force: true }),
    rm(crlf.root, { recursive: true, force: true }),
    rm(astro.root, { recursive: true, force: true }),
  ]));

  for (const target of [markdown, mdx]) {
    const token = encodeMarker(createMarker(
      path.basename(target.file), 0, 6, 'Before', 'markdown', 'p',
    ));
    const result = await applySourceImageInsert(target.root, {
      marker: token,
      src: '/assets/chart.png',
      alt: 'Chart [Q1]',
    }, '/assets/');
    assert.equal(await readFile(target.file, 'utf8'), 'Before\n\n![Chart \\[Q1\\]](/assets/chart.png)\n\nAfter\n');
    assert.equal(decodeMarker(result.marker).original, '![Chart \\[Q1\\]](/assets/chart.png)');
  }

  const crlfResult = await applySourceImageInsert(crlf.root, {
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p')),
    src: '/assets/chart.png',
    alt: 'Chart',
  }, '/assets/');
  assert.equal(await readFile(crlf.file, 'utf8'), 'Before\r\n\r\n![Chart](/assets/chart.png)\r\n\r\nAfter\r\n');
  assert.equal(decodeMarker(crlfResult.marker).original, '![Chart](/assets/chart.png)');

  const astroSource = await readFile(astro.file, 'utf8');
  const start = astroSource.indexOf('<p>Before</p>');
  const result = await applySourceImageInsert(astro.root, {
    marker: encodeMarker(createMarker(
      'page.astro', start, start + 13, '<p>Before</p>', 'astro', 'p',
    )),
    src: '/assets/chart.png',
    alt: 'Chart & "details"',
  }, '/assets/');
  assert.equal(
    await readFile(astro.file, 'utf8'),
    '<main>\n  <p>Before</p>\n  <p><img src="/assets/chart.png" alt="Chart &amp; &quot;details&quot;" /></p>\n  <p>After</p>\n</main>\n',
  );
  assert.equal(decodeMarker(result.marker).tag, 'p');
});

test('inserts native video figures after Astro, Markdown, and MDX blocks', async (t) => {
  const cases = [
    { extension: '.astro', format: 'astro' as const, source: '  <p>Before</p>\n', separator: '\n  ', newline: '\n' },
    { extension: '.md', format: 'markdown' as const, source: 'Before\n', separator: '\n\n', newline: '\n' },
    { extension: '.mdx', format: 'markdown' as const, source: 'Before\r\n', separator: '\r\n\r\n', newline: '\r\n' },
  ];
  for (const item of cases) {
    const current = await fixture(item.source, item.extension);
    t.after(() => rm(current.root, { recursive: true, force: true }));
    const original = item.format === 'astro' ? '<p>Before</p>' : 'Before';
    const start = item.source.indexOf(original);
    const result = await applySourceVideoInsert(current.root, {
      marker: encodeMarker(createMarker(
        `page${item.extension}`, start, start + original.length, original, item.format, 'p',
      )),
      src: '/media/videos/walkthrough.mp4',
      label: 'Product walkthrough',
      description: 'A short tour of the project dashboard.',
      poster: '/media/posters/walkthrough.png',
      controls: true,
      preload: 'metadata',
      muted: true,
      loop: true,
      autoplay: true,
    }, '/media/videos/');
    const indentation = item.format === 'astro' ? '  ' : '';
    const figure = [
      '<figure>',
      '  <video controls preload="metadata" aria-label="Product walkthrough" poster="/media/posters/walkthrough.png" muted loop autoplay playsinline>',
      '    <source src="/media/videos/walkthrough.mp4" type="video/mp4" />',
      '    <a href="/media/videos/walkthrough.mp4">Download Product walkthrough</a>.',
      '  </video>',
      '  <figcaption>A short tour of the project dashboard.</figcaption>',
      '</figure>',
    ].map((line, index) => index === 0 ? line : `${indentation}${line}`).join(item.newline);
    assert.equal(
      await readFile(current.file, 'utf8'),
      item.source.slice(0, start + original.length) + item.separator + figure
        + item.source.slice(start + original.length),
    );
    assert.equal(decodeMarker(result.marker).original, figure);
  }
});

test('uses safe video defaults and rejects invalid playback or accessibility values', async (t) => {
  const source = 'Before\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p'));
  const base = {
    marker,
    src: '/videos/clip.mp4',
    label: 'Demo video',
    description: 'A narrated product demonstration.',
    controls: true,
    preload: 'none' as const,
    muted: false,
    loop: false,
    autoplay: false,
  };

  await applySourceVideoInsert(root, base, '/videos/');
  assert.match(await readFile(file, 'utf8'), /<video controls preload="none" aria-label="Demo video" playsinline>/);
  await writeFile(file, source);
  await assert.rejects(applySourceVideoInsert(root, base, 'videos'), /configured video asset URL/i);
  await assert.rejects(applySourceVideoInsert(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, 6, 'Before', 'frontmatter', 'p')),
  }, '/videos/'), /frontmatter fields/i);
  assert.equal(await readFile(file, 'utf8'), source);

  for (const [patch, expected] of [
    [{ src: '/other/clip.mp4' }, /configured video asset directory/i],
    [{ src: '/videos/clip.webm' }, /valid video reference/i],
    [{ label: '' }, /accessible label/i],
    [{ description: '' }, /visible description/i],
    [{ controls: false }, /native video controls/i],
    [{ preload: 'eager' }, /preload/i],
    [{ autoplay: true, muted: false }, /Autoplay requires muted/i],
    [{ poster: 'https://example.com/poster.png' }, /public poster/i],
    [{ poster: '/posters/poster.svg' }, /public poster/i],
  ] as const) {
    await assert.rejects(
      applySourceVideoInsert(root, { ...base, ...patch } as never, '/videos/'),
      expected,
    );
    assert.equal(await readFile(file, 'utf8'), source);
  }
});

test('inserts and updates native iframe markup in Astro, Markdown, and MDX source', async (t) => {
  const origins = ['self', 'https://player.example.com'];
  for (const [extension, format, source, separator] of [
    ['.astro', 'astro', '<p>Before</p>\n', '\n'],
    ['.md', 'markdown', 'Before\n', '\n\n'],
    ['.mdx', 'markdown', 'Before\n', '\n\n'],
    ['.md', 'markdown', 'Before\r\n', '\r\n\r\n'],
  ] as const) {
    const current = await fixture(source, extension);
    t.after(() => rm(current.root, { recursive: true, force: true }));
    const original = format === 'astro' ? '<p>Before</p>' : 'Before';
    const result = await applySourceIframeInsert(current.root, {
      marker: encodeMarker(createMarker(`page${extension}`, 0, original.length, original, format, 'p')),
      src: '/embed-preview', title: 'Project status', width: 640, height: 360,
      loading: 'lazy', referrerPolicy: 'strict-origin-when-cross-origin',
      allow: ['fullscreen'], sandbox: ['allow-scripts'], allowFullscreen: true,
    }, origins);
    const inserted = decodeMarker(result.marker).original;
    assert.equal(await readFile(current.file, 'utf8'), `${original}${separator}${inserted}${source.slice(original.length)}`);
    assert.match(inserted, /^<iframe src="\/embed-preview" title="Project status"/);

    await applySourceIframeReplacement(current.root, {
      marker: result.marker,
      src: 'https://player.example.com/embed/2', title: 'Updated project status', width: 800, height: 450,
      loading: 'eager', referrerPolicy: 'no-referrer', allow: [], sandbox: [], allowFullscreen: false,
    }, origins);
    const updated = await readFile(current.file, 'utf8');
    assert.match(updated, /<iframe src="https:\/\/player\.example\.com\/embed\/2" title="Updated project status" width="800" height="450" loading="eager" referrerpolicy="no-referrer" sandbox=""><\/iframe>/);
    assert.ok(updated.startsWith(original));
  }
});

test('rejects unsafe, unsupported, frontmatter, and conflicting iframe edits without changing source', async (t) => {
  const iframe = '<iframe src="/embed-preview" title="Status" width="640" height="360" loading="lazy" referrerpolicy="no-referrer" sandbox=""></iframe>';
  const { root, file } = await fixture(`${iframe}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = {
    marker: encodeMarker(createMarker('page.md', 0, iframe.length, iframe, 'markdown', 'iframe')),
    src: '/embed-preview', title: 'Status', width: 640, height: 360,
    loading: 'lazy' as const, referrerPolicy: 'no-referrer' as const,
    allow: [], sandbox: [], allowFullscreen: false,
  };
  await assert.rejects(applySourceIframeReplacement(root, { ...base, src: 'javascript:alert(1)' }, ['self']), /valid iframe URL|approved/);
  await assert.rejects(applySourceIframeReplacement(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, iframe.length, iframe, 'frontmatter', 'iframe')),
  }, ['self']), /frontmatter fields/i);
  await assert.rejects(applySourceIframeInsert(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, iframe.length, iframe, 'frontmatter', 'iframe')),
  }, ['self']), /frontmatter fields/i);
  await assert.rejects(applySourceIframeReplacement(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, iframe.length, iframe.replace('Status', 'Stale'), 'markdown', 'iframe')),
  }, ['self']), /source changed/i);
  await writeFile(file, 'Plain\n');
  await assert.rejects(applySourceIframeReplacement(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, 5, 'Plain', 'markdown', 'p')),
  }, ['self']), /supported iframe/i);
  assert.equal(await readFile(file, 'utf8'), 'Plain\n');
});

test('replaces native Astro, Markdown, and MDX videos while preserving tracks and fallback markup', async (t) => {
  const video = '<figure class="media">\n  <video controls preload="metadata" aria-label="Old tour" poster="/assets/old.png" muted loop playsinline class="player">\n    <source src="/assets/old.mp4" type="video/mp4" />\n    <track kind="captions" src="/assets/tour.vtt" srclang="en" label="English" default />\n    <a href="/assets/old.mp4" download>Download the tour</a>.\n  </video>\n  <figcaption class="caption">Old visible description.</figcaption>\n</figure>';
  for (const [extension, format] of [['.astro', 'astro'], ['.md', 'markdown'], ['.mdx', 'markdown']] as const) {
    const source = `Before\n\n${video}\n\nAfter\n`;
    const current = await fixture(source, extension);
    t.after(() => rm(current.root, { recursive: true, force: true }));
    const start = source.indexOf(video);
    const result = await applySourceVideoReplacement(current.root, {
      marker: encodeMarker(createMarker(`page${extension}`, start, start + video.length, video, format, 'figure')),
      src: '/media/new.mp4',
      label: 'New & improved tour',
      description: 'New visible description.',
      controls: true,
      preload: 'none',
      muted: true,
      loop: false,
      autoplay: true,
    });
    const updated = await readFile(current.file, 'utf8');
    assert.match(updated, /<video controls preload="none" aria-label="New &amp; improved tour" muted playsinline class="player" autoplay>/);
    assert.match(updated, /<source src="\/media\/new\.mp4" type="video\/mp4" \/>/);
    assert.match(updated, /<track kind="captions" src="\/assets\/tour\.vtt" srclang="en" label="English" default \/>/);
    assert.match(updated, /<a href="\/media\/new\.mp4" download>Download the tour<\/a>/);
    assert.match(updated, /<figcaption class="caption">New visible description\.<\/figcaption>/);
    assert.ok(updated.startsWith('Before\n\n') && updated.endsWith('\n\nAfter\n'));
    assert.equal(decodeMarker(result.marker).original, updated.slice(start, updated.lastIndexOf('\n\nAfter')));
  }
});

test('rejects unsupported or conflicting video replacements without changing source', async (t) => {
  const video = '<figure><video controls preload="metadata" aria-label="Tour"><source src="/assets/old.mp4" type="video/mp4" /></video><figcaption>Tour description.</figcaption></figure>';
  const { root, file } = await fixture(`${video}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = {
    marker: encodeMarker(createMarker('page.md', 0, video.length, video, 'markdown', 'figure')),
    src: '/assets/new.mp4',
    label: 'New tour',
    description: 'New description.',
    controls: true,
    preload: 'metadata' as const,
    muted: false,
    loop: false,
    autoplay: false,
  };
  for (const patch of [
    { src: 'https://example.com/new.mp4' },
    { controls: false },
    { autoplay: true, muted: false },
    { preload: 'eager' },
  ]) {
    await assert.rejects(applySourceVideoReplacement(root, { ...base, ...patch } as never));
    assert.equal(await readFile(file, 'utf8'), `${video}\n`);
  }
  await assert.rejects(applySourceVideoReplacement(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, video.length, video, 'frontmatter', 'figure')),
  }), /frontmatter fields/i);
  await assert.rejects(applySourceVideoReplacement(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, video.length, video.replace('old', 'stale'), 'markdown', 'figure')),
  }), /source changed/i);
  await writeFile(file, 'Plain text\n');
  await assert.rejects(applySourceVideoReplacement(root, {
    ...base,
    marker: encodeMarker(createMarker('page.md', 0, 10, 'Plain text', 'markdown', 'p')),
  }), /supported native video/i);
  assert.equal(await readFile(file, 'utf8'), 'Plain text\n');
});

test('replaces one Markdown or MDX image while preserving links, titles, captions, and surrounding text', async (t) => {
  const markdownSource = 'Before\n\n[![Old alt](/assets/old.png "Title")](/docs) Caption\n\nAfter\n';
  const markdown = await fixture(markdownSource);
  const mdxSource = 'Before\n\n![Old](../assets/old.png)\n\nAfter\n';
  const mdx = await fixture(mdxSource, '.mdx');
  t.after(() => Promise.all([
    rm(markdown.root, { recursive: true, force: true }),
    rm(mdx.root, { recursive: true, force: true }),
  ]));

  const markdownOriginal = '[![Old alt](/assets/old.png "Title")](/docs) Caption';
  const markdownStart = markdownSource.indexOf(markdownOriginal);
  const markdownResult = await applySourceImageReplacement(markdown.root, {
    marker: encodeMarker(createMarker(
      'page.md', markdownStart, markdownStart + markdownOriginal.length,
      markdownOriginal, 'markdown', 'p',
    )),
    src: '/assets/new.png',
    alt: 'New [alt]',
    assetKind: 'public',
  });
  assert.equal(
    await readFile(markdown.file, 'utf8'),
    'Before\n\n[![New \\[alt\\]](/assets/new.png "Title")](/docs) Caption\n\nAfter\n',
  );
  assert.equal(
    decodeMarker(markdownResult.marker).original,
    '[![New \\[alt\\]](/assets/new.png "Title")](/docs) Caption',
  );

  const mdxOriginal = '![Old](../assets/old.png)';
  const mdxStart = mdxSource.indexOf(mdxOriginal);
  await applySourceImageReplacement(mdx.root, {
    marker: encodeMarker(createMarker(
      'page.mdx', mdxStart, mdxStart + mdxOriginal.length, mdxOriginal, 'markdown', 'p',
    )),
    src: '../assets/new.png',
    alt: 'New MDX image',
    assetKind: 'source',
  });
  assert.equal(
    await readFile(mdx.file, 'utf8'),
    'Before\n\n![New MDX image](../assets/new.png)\n\nAfter\n',
  );
});

test('replaces public and imported Astro images while preserving compatible markup', async (t) => {
  const publicSource = '<figure>\n  <p class="hero"><a href="/docs"><img loading="lazy" src="/assets/old.png" alt="Old" width="400" /></a> Caption</p>\n  <figcaption>Kept caption</figcaption>\n</figure>\n';
  const publicImage = await fixture(publicSource, '.astro');
  const importedSource = '---\nimport photo from "../assets/old.png";\n---\n<p class="hero"><img src={photo.src} alt="Old" height="200" /></p>\n';
  const importedImage = await fixture(importedSource, '.astro');
  t.after(() => Promise.all([
    rm(publicImage.root, { recursive: true, force: true }),
    rm(importedImage.root, { recursive: true, force: true }),
  ]));

  const publicOriginal = '<p class="hero"><a href="/docs"><img loading="lazy" src="/assets/old.png" alt="Old" width="400" /></a> Caption</p>';
  const publicStart = publicSource.indexOf(publicOriginal);
  await applySourceImageReplacement(publicImage.root, {
    marker: encodeMarker(createMarker(
      'page.astro', publicStart, publicStart + publicOriginal.length,
      publicOriginal, 'astro', 'p',
    )),
    src: '/assets/new.webp',
    alt: 'New & improved',
    assetKind: 'public',
  });
  assert.equal(
    await readFile(publicImage.file, 'utf8'),
    publicSource.replace(
      publicOriginal,
      '<p class="hero"><a href="/docs"><img loading="lazy" src="/assets/new.webp" alt="New &amp; improved" width="400" /></a> Caption</p>',
    ),
  );

  const importedOriginal = '<p class="hero"><img src={photo.src} alt="Old" height="200" /></p>';
  const importedStart = importedSource.indexOf(importedOriginal);
  const importedResult = await applySourceImageReplacement(importedImage.root, {
    marker: encodeMarker(createMarker(
      'page.astro', importedStart, importedStart + importedOriginal.length,
      importedOriginal, 'astro', 'p',
    )),
    src: '../assets/longer-replacement.png',
    alt: 'Imported replacement',
    assetKind: 'source',
  });
  assert.equal(
    await readFile(importedImage.file, 'utf8'),
    '---\nimport photo from "../assets/longer-replacement.png";\n---\n<p class="hero"><img src={photo.src} alt="Imported replacement" height="200" /></p>\n',
  );
  assert.equal(
    decodeMarker(importedResult.marker).start,
    importedStart + '../assets/longer-replacement.png'.length - '../assets/old.png'.length,
  );
});

test('rejects ambiguous, unsupported, and conflicting image replacements without changing source', async (t) => {
  const source = '<p><img src="/assets/a.png" alt="A" /><img src="/assets/b.png" alt="B" /></p>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const edit = {
    marker: encodeMarker(createMarker('page.astro', 0, source.trimEnd().length, source.trimEnd(), 'astro', 'p')),
    src: '/assets/new.png',
    alt: 'Replacement',
    assetKind: 'public' as const,
  };

  await assert.rejects(applySourceImageReplacement(root, edit), /exactly one supported image/i);
  assert.equal(await readFile(file, 'utf8'), source);

  const noImage = '<p>No image</p>';
  await writeFile(file, `${noImage}\n`);
  await assert.rejects(applySourceImageReplacement(root, {
    ...edit,
    marker: encodeMarker(createMarker('page.astro', 0, noImage.length, noImage, 'astro', 'p')),
  }), /exactly one supported image/i);
  await assert.rejects(applySourceImageReplacement(root, {
    ...edit,
    marker: encodeMarker(createMarker('page.astro', 0, noImage.length, 'Stale image block', 'astro', 'p')),
  }), /source changed/i);
  assert.equal(await readFile(file, 'utf8'), `${noImage}\n`);
});

test('rejects replacing an imported Astro asset used by more than one construct', async (t) => {
  const original = '<p><img src={photo.src} alt="First" /></p>';
  const source = `---\nimport photo from "../assets/old.png";\n---\n${original}\n<p><img src={photo.src} alt="Second" /></p>\n`;
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf(original);

  await assert.rejects(applySourceImageReplacement(root, {
    marker: encodeMarker(createMarker(
      'page.astro', start, start + original.length, original, 'astro', 'p',
    )),
    src: '../assets/new.png',
    alt: 'Replacement',
    assetKind: 'source',
  }), /used by more than one construct/i);
  assert.equal(await readFile(file, 'utf8'), source);
});

test('rejects unsupported replacement markers, references, attributes, and imported sources', async (t) => {
  const { root, file } = await fixture('<p>Initial</p>\n', '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const attempt = async (
    source: string,
    format: 'astro' | 'frontmatter' | 'markdown',
    patch: Partial<Parameters<typeof applySourceImageReplacement>[1]>,
    expected: RegExp,
  ) => {
    await writeFile(file, source);
    const original = source.trimEnd();
    await assert.rejects(applySourceImageReplacement(root, {
      marker: encodeMarker(createMarker('page.astro', 0, original.length, original, format, 'p')),
      src: '/assets/new.png',
      alt: 'Replacement',
      assetKind: 'public',
      ...patch,
    }), expected);
    assert.equal(await readFile(file, 'utf8'), source);
  };

  await attempt('title\n', 'frontmatter', {}, /Frontmatter fields/i);
  await attempt('<p><img src="/assets/old.png" alt="Old" /></p>\n', 'astro', {
    src: 'relative.png',
  }, /valid public or source image reference/i);
  await attempt('No image here\n', 'markdown', {}, /exactly one supported image/i);
  await attempt('<p><img src="/assets/old.png" alt="Old" /></p>\n', 'astro', {
    src: '../assets/new.png', assetKind: 'source',
  }, /existing imported Astro image/i);
  await attempt('<p><img alt="Old" /></p>\n', 'astro', {}, /attributes are ambiguous/i);
  await attempt('<p><img src="/assets/old.png" alt="One" alt="Two" /></p>\n', 'astro', {}, /attributes are ambiguous/i);
  await attempt('<p><img src="/assets/old.png" alt="Old"\n', 'astro', {}, /markup is incomplete/i);
  await attempt('<p><img src={photo.src} alt="Old" /></p>\n', 'astro', {
    src: '../assets/new.png', assetKind: 'source',
  }, /imported image source is ambiguous/i);
});

test('adds missing alt markup when replacing a supported Astro image', async (t) => {
  const source = '<p><img class="hero" src="/assets/old.png" /></p>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = source.trimEnd();
  await applySourceImageReplacement(root, {
    marker: encodeMarker(createMarker('page.astro', 0, original.length, original, 'astro', 'p')),
    src: '/assets/new.png',
    alt: 'Added alt text',
    assetKind: 'public',
  });
  assert.equal(
    await readFile(file, 'utf8'),
    '<p><img class="hero" src="/assets/new.png" alt="Added alt text" /></p>\n',
  );
});

test('rejects image insertion outside the configured asset URL or without useful alt text', async (t) => {
  const source = 'Before\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = encodeMarker(createMarker('page.md', 0, 6, 'Before', 'markdown', 'p'));

  for (const edit of [
    { marker, src: '/other/chart.png', alt: 'Chart' },
    { marker, src: '/assets/../chart.png', alt: 'Chart' },
    { marker, src: '/assets/chart.svg', alt: 'Chart' },
    { marker, src: '/assets/chart.png', alt: '' },
    { marker, src: '/assets/chart.png', alt: 'line\nbreak' },
  ]) {
    await assert.rejects(applySourceImageInsert(root, edit, '/assets/'), /image|alt text/i);
    assert.equal(await readFile(file, 'utf8'), source);
  }
  await assert.rejects(
    applySourceImageInsert(root, { marker, src: '/assets/chart.png', alt: 'Chart' }, 'assets'),
    /configured image asset URL/i,
  );
  const frontmatterMarker = encodeMarker(createMarker('page.md', 0, 6, 'Before', 'frontmatter', 'p'));
  await assert.rejects(
    applySourceImageInsert(root, {
      marker: frontmatterMarker, src: '/assets/chart.png', alt: 'Chart',
    }, '/assets/'),
    /frontmatter/i,
  );
  assert.equal(await readFile(file, 'utf8'), source);
});

test('adds an Astro paragraph with the selected block indentation', async (t) => {
  const source = '<div>\n  <p>First</p>\n  <p>Second</p>\n</div>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('<p>First</p>');
  const token = encodeMarker(createMarker('page.astro', start, start + 12, '<p>First</p>', 'astro', 'p'));

  await applySourceStructureEdit(root, { marker: token, operation: 'insert-after' });

  assert.equal(
    await readFile(file, 'utf8'),
    '<div>\n  <p>First</p>\n  <p>New paragraph</p>\n  <p>Second</p>\n</div>\n',
  );
});

test('deletes only the selected Markdown block and its separator', async (t) => {
  const source = 'First block\n\nSecond block\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'First block', 'markdown', 'p'));

  const result = await applySourceStructureEdit(root, { marker: token, operation: 'delete' });

  assert.equal(await readFile(file, 'utf8'), 'Second block\n');
  assert.equal(result.marker, undefined);
});

test('deletes an Astro block without leaving an empty indented line', async (t) => {
  const source = '<div>\n  <p>First</p>\n  <p>Second</p>\n</div>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('<p>First</p>');
  const token = encodeMarker(createMarker('page.astro', start, start + 12, '<p>First</p>', 'astro', 'p'));

  await applySourceStructureEdit(root, { marker: token, operation: 'delete' });

  assert.equal(await readFile(file, 'utf8'), '<div>\n  <p>Second</p>\n</div>\n');
});

test('rejects structural edits to frontmatter fields', async (t) => {
  const source = '---\ntitle: Example\n---\nBody\n';
  const { root } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 7, 21, 'title: Example', 'frontmatter', 'h1'));

  await assert.rejects(
    applySourceStructureEdit(root, { marker: token, operation: 'delete' }),
    /Frontmatter fields cannot be added or deleted/,
  );
});

test('updates a quoted frontmatter title as plain text', async (t) => {
  const source = '---\ntitle: "Old title"\n---\nBody\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('"Old title"');
  const token = encodeMarker(createMarker('page.md', start, start + 11, '"Old title"', 'frontmatter', 'h1'));

  await applySourceEdit(root, {
    marker: token,
    html: 'New &amp; better title',
    text: 'New & better title',
    tag: 'h1',
  });

  assert.equal(await readFile(file, 'utf8'), '---\ntitle: "New & better title"\n---\nBody\n');
});

test('derives plain frontmatter text from HTML when text is omitted', async (t) => {
  const source = '---\ntitle: Old\n---\nBody\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('Old');
  await applySourceEdit(root, {
    marker: encodeMarker(createMarker('page.md', start, start + 3, 'Old', 'frontmatter', 'h1')),
    html: 'Safe value',
  });
  assert.match(await readFile(file, 'utf8'), /title: Safe value/);
});

test('preserves a Markdown list marker while editing an item', async (t) => {
  const source = '- Old **item**\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, source.trimEnd().length, source.trimEnd(), 'markdown', 'li'));

  await applySourceEdit(root, { marker: token, html: 'New <strong>item</strong>', tag: 'li' });

  assert.equal(await readFile(file, 'utf8'), '- New **item**\n');
});

test('changes a Markdown paragraph to a bullet list', async (t) => {
  const source = 'One and two\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'One and two', 'markdown', 'p'));

  await applySourceEdit(root, {
    marker: token,
    html: '<li>One</li><li>Two</li>',
    tag: 'ul',
  });

  assert.equal(await readFile(file, 'utf8'), '- One\n- Two\n');
});

test('changes a Markdown paragraph to a heading', async (t) => {
  const source = 'A paragraph\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('page.md', 0, 11, 'A paragraph', 'markdown', 'p'));

  await applySourceEdit(root, { marker: token, html: 'A title', tag: 'h1' });

  assert.equal(await readFile(file, 'utf8'), '# A title\n');
});

test('relocates an unchanged unique block after an earlier edit shifted offsets', async (t) => {
  const source = 'First\n\nSecond\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const secondStart = source.indexOf('Second');
  const staleToken = encodeMarker(createMarker('page.md', secondStart, secondStart + 6, 'Second', 'markdown', 'p'));
  await writeFile(file, 'A much longer first paragraph\n\nSecond\n');

  await applySourceEdit(root, { marker: staleToken, html: 'Updated second' });

  assert.equal(await readFile(file, 'utf8'), 'A much longer first paragraph\n\nUpdated second\n');
});

test('rejects paths outside the project root', async (t) => {
  const { root } = await fixture('safe');
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = encodeMarker(createMarker('../outside.md', 0, 4, 'safe', 'markdown', 'p'));

  await assert.rejects(
    applySourceEdit(root, { marker: token, html: 'unsafe' }),
    /outside the Astro project root/,
  );
});

test('rejects unsupported, missing, stale, and ambiguous source targets', async (t) => {
  const unsupported = await fixture('text', '.txt');
  const unsupportedMarkdoc = await fixture('text', '.mdoc');
  const missingRoot = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-'));
  const ambiguous = await fixture('Same\n\nSame\n');
  t.after(() => Promise.all([
    rm(unsupported.root, { recursive: true, force: true }),
    rm(unsupportedMarkdoc.root, { recursive: true, force: true }),
    rm(missingRoot, { recursive: true, force: true }),
    rm(ambiguous.root, { recursive: true, force: true }),
  ]));

  for (const [target, file] of [
    [unsupported, 'page.txt'],
    [unsupportedMarkdoc, 'page.mdoc'],
  ] as const) await assert.rejects(
    applySourceEdit(target.root, {
      marker: encodeMarker(createMarker(file, 0, 4, 'text', 'markdown', 'p')),
      html: 'changed',
    }),
    /file type cannot be edited/,
  );
  await assert.rejects(
    applySourceEdit(missingRoot, {
      marker: encodeMarker(createMarker('missing.md', 0, 4, 'text', 'markdown', 'p')),
      html: 'changed',
    }),
    /no longer exists/,
  );
  await assert.rejects(
    applySourceEdit(ambiguous.root, {
      marker: encodeMarker(createMarker('page.md', 99, 103, 'Same', 'markdown', 'p')),
      html: 'changed',
    }),
    /source changed/,
  );
});

test('rejects unsupported block formats', async (t) => {
  const { root } = await fixture('Text\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    applySourceEdit(root, {
      marker: encodeMarker(createMarker('page.md', 0, 4, 'Text', 'markdown', 'p')),
      html: 'Text',
      tag: 'script',
    }),
    /block format is not supported/,
  );
});

test('serializes frontmatter quote styles and unsafe plain values', async (t) => {
  const source = "---\ntitle: 'Old'\ndescription: Plain\n---\nBody\n";
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const titleStart = source.indexOf("'Old'");
  const descriptionStart = source.indexOf('Plain');

  await applySourceEdit(root, {
    marker: encodeMarker(createMarker('page.md', titleStart, titleStart + 5, "'Old'", 'frontmatter', 'h1')),
    html: "Author's title",
    text: "Author's title",
  });
  await applySourceEdit(root, {
    marker: encodeMarker(createMarker('page.md', descriptionStart, descriptionStart + 5, 'Plain', 'frontmatter', 'p')),
    html: 'Needs: quotes',
    text: 'Needs: quotes',
  });

  assert.match(await readFile(file, 'utf8'), /title: 'Author''s title'\ndescription: "Needs: quotes"/);
});

test('serializes multiline list items and default list markers', async (t) => {
  const source = 'Old item\n';
  const { root, file } = await fixture(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  await applySourceEdit(root, {
    marker: encodeMarker(createMarker('page.md', 0, 8, 'Old item', 'markdown', 'li')),
    html: 'First<br>Second',
    tag: 'li',
  });
  assert.equal(await readFile(file, 'utf8'), '- First  \n  Second\n');
});

test('handles alternate structural separators and inline Astro blocks', async (t) => {
  const markdown = await fixture('First\r\n\r\nSecond\r\n');
  const single = await fixture('Only');
  const astro = await fixture('<div><p>First</p><p>Second</p></div>', '.astro');
  t.after(() => Promise.all([
    rm(markdown.root, { recursive: true, force: true }),
    rm(single.root, { recursive: true, force: true }),
    rm(astro.root, { recursive: true, force: true }),
  ]));

  await applySourceStructureEdit(markdown.root, {
    marker: encodeMarker(createMarker('page.md', 9, 15, 'Second', 'markdown', 'p')),
    operation: 'delete',
  });
  assert.equal(await readFile(markdown.file, 'utf8'), 'First\r\n');

  await applySourceStructureEdit(single.root, {
    marker: encodeMarker(createMarker('page.md', 0, 4, 'Only', 'markdown', 'p')),
    operation: 'delete',
  });
  assert.equal(await readFile(single.file, 'utf8'), '');

  const astroStart = '<div>'.length;
  await applySourceStructureEdit(astro.root, {
    marker: encodeMarker(createMarker('page.astro', astroStart, astroStart + 12, '<p>First</p>', 'astro', 'p')),
    operation: 'delete',
  });
  assert.equal(await readFile(astro.file, 'utf8'), '<div><p>Second</p></div>');
});

test('inserts blocks with CRLF separators and after inline Astro elements', async (t) => {
  const markdown = await fixture('First\r\n\r\nSecond\r\n');
  const astro = await fixture('<div><p>First</p><p>Second</p></div>', '.astro');
  t.after(() => Promise.all([
    rm(markdown.root, { recursive: true, force: true }),
    rm(astro.root, { recursive: true, force: true }),
  ]));
  await applySourceStructureEdit(markdown.root, {
    marker: encodeMarker(createMarker('page.md', 0, 5, 'First', 'markdown', 'p')),
    operation: 'insert-after',
  });
  assert.equal(await readFile(markdown.file, 'utf8'), 'First\r\n\r\nNew paragraph\r\n\r\nSecond\r\n');

  const start = '<div>'.length;
  await applySourceStructureEdit(astro.root, {
    marker: encodeMarker(createMarker('page.astro', start, start + 12, '<p>First</p>', 'astro', 'p')),
    operation: 'insert-after',
  });
  assert.equal(
    await readFile(astro.file, 'utf8'),
    '<div><p>First</p>\n<p>New paragraph</p><p>Second</p></div>',
  );
});

test('deletes an indented final Astro line without a trailing newline', async (t) => {
  const source = '<div>\n  <p>Last</p>';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = source.indexOf('<p>Last</p>');
  await applySourceStructureEdit(root, {
    marker: encodeMarker(createMarker('page.astro', start, start + 11, '<p>Last</p>', 'astro', 'p')),
    operation: 'delete',
  });
  assert.equal(await readFile(file, 'utf8'), '<div>\n');
});

test('changes an Astro block tag around quoted and expression attributes', async (t) => {
  const source = '<p title=">" data-value={{ text: ">" }}>Old</p>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = source.trimEnd();
  await applySourceEdit(root, {
    marker: encodeMarker(createMarker('page.astro', 0, original.length, original, 'astro', 'p')),
    html: 'New',
    tag: 'h2',
  });
  assert.equal(await readFile(file, 'utf8'), '<h2 title=">" data-value={{ text: ">" }}>New</h2>\n');
});

test('rejects malformed Astro source blocks', async (t) => {
  const { root } = await fixture('<p>missing close\n', '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    applySourceEdit(root, {
      marker: encodeMarker(createMarker('page.astro', 0, 16, '<p>missing close', 'astro', 'p')),
      html: 'New',
    }),
    /no longer editable/,
  );
});

test('rejects Astro opening tags with unterminated attributes', async (t) => {
  const original = '<p title="unterminated>Text</p>';
  const { root } = await fixture(`${original}\n`, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    applySourceEdit(root, {
      marker: encodeMarker(createMarker('page.astro', 0, original.length, original, 'astro', 'p')),
      html: 'New',
    }),
    /no longer editable/,
  );
});

test('preserves Astro element attributes and changes only its static inner HTML', async (t) => {
  const source = '<p class="lead">Old <em>text</em></p>\n';
  const { root, file } = await fixture(source, '.astro');
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = source.trimEnd();
  const token = encodeMarker(createMarker('page.astro', 0, original.length, original, 'astro', 'p'));

  await applySourceEdit(root, { marker: token, html: 'New <strong>text</strong>' });

  assert.equal(await readFile(file, 'utf8'), '<p class="lead">New <strong>text</strong></p>\n');
});
