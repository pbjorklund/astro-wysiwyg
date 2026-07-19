import assert from 'node:assert/strict';
import { chmod, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applySourceEdit, applySourceStructureEdit } from '../src/persist.ts';
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
