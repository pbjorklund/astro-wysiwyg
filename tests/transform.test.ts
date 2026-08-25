import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarker, decodeMarker, encodeMarker } from '../src/marker.ts';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  annotateAstroSource,
  annotateAstroSourceLocations,
  resolveAstroSourceMarker,
} from '../src/astro-transform.ts';
import { rehypeEditableBlocks, remarkEditableMedia } from '../src/rehype.ts';

function markerFromHtml(html: string): string {
  const match = html.match(/data-astro-wysiwyg="([A-Za-z0-9_-]+)"/);
  assert.ok(match, `No editor marker in ${html}`);
  return match[1];
}

test('adds Astro 7 source locations to static and dynamic editable tags', async () => {
  const source = '<main>\n  <h1>Static</h1>\n  <p>{dynamic}</p>\n  <span>{tag}</span>\n  <span>Static label</span>\n  <hr />\n</main>';
  const transformed = await annotateAstroSourceLocations(
    source,
    '/project/src/pages/index.astro',
    '/project',
  );

  assert.match(
    transformed ?? '',
    /<h1 data-astro-source-file="src\/pages\/index\.astro" data-astro-source-loc="2:3">/,
  );
  assert.match(
    transformed ?? '',
    /<p data-astro-source-file="src\/pages\/index\.astro" data-astro-source-loc="3:3">/,
  );
  assert.match(
    transformed ?? '',
    /<span data-astro-source-file="src\/pages\/index\.astro" data-astro-source-loc="4:3">\{tag\}<\/span>/,
  );
  assert.match(transformed ?? '', /<span>Static label<\/span>/);
  assert.match(
    transformed ?? '',
    /<hr data-astro-source-file="src\/pages\/index\.astro" data-astro-source-loc="6:3" \/>/,
  );
  assert.match(
    await annotateAstroSourceLocations('<hr/>', '/project/divider.astro', '/project') ?? '',
    /<hr data-astro-source-file="divider\.astro" data-astro-source-loc="1:1"\/>/,
  );
  assert.equal(await annotateAstroSourceLocations('<Component />', '/project/page.astro', '/project'), null);
  assert.equal(await annotateAstroSourceLocations('<p>Text</p>', '/project', '/project'), null);
  assert.equal(await annotateAstroSourceLocations('<p>Text</p>', '/outside/page.astro', '/project'), null);
});

test('annotates static Astro blocks without changing their source range', async () => {
  const source = '---\nconst title = "Dynamic";\n---\n<main><h1 class="title">Static <em>title</em></h1><p>{title}</p></main>';
  const transformed = await annotateAstroSource(source, '/project/src/pages/index.astro', '/project');

  assert.match(transformed ?? '', /<h1 class="title" data-astro-wysiwyg="/);
  assert.doesNotMatch(transformed ?? '', /<p data-astro-wysiwyg/);
  const marker = decodeMarker(markerFromHtml(transformed ?? ''));
  assert.equal(marker.file, 'src/pages/index.astro');
  assert.equal(marker.original, '<h1 class="title">Static <em>title</em></h1>');
  assert.equal(source.slice(marker.start, marker.end), marker.original);
});

test('rejects nested inline elements with source-dynamic attributes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-attributes-'));
  const file = path.join(root, 'page.astro');
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const source of [
    '<p>Read <a href={url}>this link</a></p>',
    '<p><span class:list={{ active }}>Styled text</span></p>',
    '<p><span class:list="active">Static directive text</span></p>',
    '<p><span {...props}>Spread text</span></p>',
    '<p><span {title}>Titled text</span></p>',
    '<p><span set:html={html}></span></p>',
    '<p><data value={`prefix-${value}`}>Value</data></p>',
  ]) {
    await writeFile(file, source);
    assert.equal(await annotateAstroSource(source, file, root), null);
    await assert.rejects(resolveAstroSourceMarker(root, file, '1:2'), /not a static editable block/);
  }

  const staticSource = '<p>Read <a href="/docs" title>the docs</a></p>';
  await writeFile(file, staticSource);
  assert.match(await annotateAstroSource(staticSource, file, root) ?? '', /data-astro-wysiwyg=/);
  assert.equal(decodeMarker(await resolveAstroSourceMarker(root, file, '1:2')).original, staticSource);
});

test('annotates Astro image blocks with public or simple imported sources only', async (t) => {
  const publicSource = '<p><img src="/assets/photo.png" alt="Public photo" /></p>';
  assert.match(await annotateAstroSource(publicSource, '/project/public.astro', '/project') ?? '', /data-astro-wysiwyg=/);

  const importedSource = '---\nimport photo from "../assets/photo.png";\n---\n<p><img src={photo.src} alt="Imported photo" /></p>';
  const imported = await annotateAstroSource(importedSource, '/project/imported.astro', '/project');
  assert.match(imported ?? '', /data-astro-wysiwyg=/);
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-imported-image-'));
  const file = path.join(root, 'page.astro');
  await writeFile(file, importedSource);
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    decodeMarker(await resolveAstroSourceMarker(root, file, '4:10')).original,
    '<p><img src={photo.src} alt="Imported photo" /></p>',
  );

  for (const source of [
    '<p><img src={getImage()} alt="Dynamic" /></p>',
    '<p><img src={images[index].src} alt="Dynamic" /></p>',
    '<p><img src={photo.src} alt={description} /></p>',
    '<p><img src={photo.src} alt="Missing import" /></p>',
    '---\nimport photo from "../assets/photo.png";\n---\n<p><img src={photo.src} alt="First" /></p>\n<p><img src={photo.src} alt="Second" /></p>',
  ]) {
    assert.equal(await annotateAstroSource(source, '/project/dynamic.astro', '/project'), null);
  }
});

test('resolves Astro dev source locations to safe static blocks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-resolve-'));
  const file = path.join(root, 'page.astro');
  const source = '<main>\n  <p class="lead">Editable text</p>\n  <p>{dynamic}</p>\n  <p>{dynamic} suffix</p>\n</main>';
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));

  const token = await resolveAstroSourceMarker(root, file, '2:19');
  assert.equal(decodeMarker(token).original, '<p class="lead">Editable text</p>');
  await assert.rejects(resolveAstroSourceMarker(root, file, '3:6'), /not a static editable block/);
  await assert.rejects(resolveAstroSourceMarker(root, file, '4:6'), /not a static editable block/);
});

test('resolves Astro source locations in files with non-ASCII (UTF-8) content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-utf8-'));
  const file = path.join(root, 'page.astro');
  const frontmatter = '---\ntitle: "Åtgärder och förbättringar"\ndescription: "Swedish text with ä, ö, å characters"\n---\n\n';
  const body = '<main>\n  <p class="kicker">Plattform för verksamhetsstyrning</p>\n  <p>Processer, mål, risker och avvikelser finns på ett ställe.</p>\n</main>';
  await writeFile(file, frontmatter + body);
  t.after(() => rm(root, { recursive: true, force: true }));

  // The Astro compiler reports UTF-8 byte offsets, not JS string indices.
  // Lines are 1-indexed from the file start (including frontmatter).
  // Frontmatter is 4 lines, so the kicker <p> is on line 6.
  const kickerLine = frontmatter.split('\n').length; // line where <main> starts
  const kicker = await resolveAstroSourceMarker(root, file, `${kickerLine + 1}:17`);
  assert.equal(decodeMarker(kicker).original, '<p class="kicker">Plattform för verksamhetsstyrning</p>');

  const subtitle = await resolveAstroSourceMarker(root, file, `${kickerLine + 2}:6`);
  assert.equal(decodeMarker(subtitle).original, '<p>Processer, mål, risker och avvikelser finns på ett ställe.</p>');
});

test('chooses the smallest nested static Astro block', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-nested-'));
  const file = path.join(root, 'page.astro');
  await writeFile(file, '<ul><li><p>Nested text</p></li></ul>');
  t.after(() => rm(root, { recursive: true, force: true }));

  const token = await resolveAstroSourceMarker(root, file, '1:13');
  assert.equal(decodeMarker(token).original, '<p>Nested text</p>');
});

test('resolves a dynamic data title through the current content marker', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-title-'));
  const pageFile = path.join(root, 'src/pages/article.astro');
  const contentFile = path.join(root, 'src/content/articles/post.md');
  await Promise.all([
    mkdir(path.dirname(pageFile), { recursive: true }),
    mkdir(path.dirname(contentFile), { recursive: true }),
  ]);
  await writeFile(pageFile, '<h1 class="title">{article.data.title}</h1>');
  const content = '---\ntitle: "Current title"\n---\nBody text\n';
  await writeFile(contentFile, content);
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodyStart = content.indexOf('Body text');
  const context = encodeMarker(createMarker(
    'src/content/articles/post.md', bodyStart, bodyStart + 9, 'Body text', 'markdown', 'p',
  ));

  const token = await resolveAstroSourceMarker(root, pageFile, '1:22', {
    contextMarker: context,
    renderedText: 'Current title',
  });
  const marker = decodeMarker(token);
  assert.equal(marker.file, 'src/content/articles/post.md');
  assert.equal(marker.format, 'frontmatter');
  assert.equal(marker.original, '"Current title"');
});

test('resolves destructured article fields and list items through the current content marker', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-frontmatter-values-'));
  const pageFile = path.join(root, 'src/layouts/ArticleLayout.astro');
  const contentFile = path.join(root, 'src/content/articles/post.md');
  await Promise.all([
    mkdir(path.dirname(pageFile), { recursive: true }),
    mkdir(path.dirname(contentFile), { recursive: true }),
  ]);
  await writeFile(pageFile, '<h1>{title}</h1><div>{tags.map((tag) => <span>{tag}</span>)}</div>');
  const content = '---\ntitle: "Current title"\ntags: ["Policy", "ISO"]\n---\nBody text\n';
  await writeFile(contentFile, content);
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodyStart = content.indexOf('Body text');
  const context = encodeMarker(createMarker(
    'src/content/articles/post.md', bodyStart, bodyStart + 9, 'Body text', 'markdown', 'p',
  ));

  const title = decodeMarker(await resolveAstroSourceMarker(root, pageFile, '1:8', {
    contextMarker: context,
    renderedText: 'Current title',
  }));
  assert.equal(title.format, 'frontmatter');
  assert.equal(title.field, 'title');

  const tag = decodeMarker(await resolveAstroSourceMarker(root, pageFile, '1:53', {
    contextMarker: context,
    renderedText: 'Policy',
  }));
  assert.equal(tag.format, 'frontmatter');
  assert.equal(tag.field, 'tags');
  assert.equal(tag.original, '["Policy", "ISO"]');
});

test('resolves a rendered article card through its linked content slug', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-card-'));
  const pageFile = path.join(root, 'src/components/Card.astro');
  const contentFile = path.join(root, 'src/content/articles/example/index.md');
  await Promise.all([
    mkdir(path.dirname(pageFile), { recursive: true }),
    mkdir(path.dirname(contentFile), { recursive: true }),
  ]);
  await writeFile(pageFile, '<a href="/articles/example"><h2>{article.data.title}</h2></a>');
  await writeFile(contentFile, '---\ntitle: "Rendered card title"\ndescription: "Summary"\n---\nBody\n');
  t.after(() => rm(root, { recursive: true, force: true }));

  const token = await resolveAstroSourceMarker(root, pageFile, '1:42', {
    contextHref: '/articles/example',
    renderedText: 'Rendered card title',
  });
  const marker = decodeMarker(token);
  assert.equal(marker.file, 'src/content/articles/example/index.md');
  assert.equal(marker.format, 'frontmatter');
  assert.equal(marker.original, '"Rendered card title"');

  const singular = await resolveAstroSourceMarker(root, pageFile, '1:42', {
    contextHref: '/article/example',
    renderedText: 'Rendered card title',
  });
  assert.equal(decodeMarker(singular).file, 'src/content/articles/example/index.md');
});

test('uses the clicked link instead of an unrelated document context marker', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-context-priority-'));
  const pageFile = path.join(root, 'src/components/Card.astro');
  const linkedFile = path.join(root, 'src/content/articles/linked/index.md');
  const contextFile = path.join(root, 'src/content/articles/current.md');
  await Promise.all([
    mkdir(path.dirname(pageFile), { recursive: true }),
    mkdir(path.dirname(linkedFile), { recursive: true }),
  ]);
  await writeFile(pageFile, '<a href="/articles/linked"><h2>{article.data.title}</h2></a>');
  await writeFile(linkedFile, '---\ntitle: "Shared title"\n---\nLinked body\n');
  await writeFile(contextFile, '---\ntitle: "Shared title"\n---\nCurrent body\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const contextMarker = encodeMarker(createMarker(
    'src/content/articles/current.md', 0, 0, '', 'markdown', 'p',
  ));

  const token = await resolveAstroSourceMarker(root, pageFile, '1:41', {
    contextMarker,
    contextHref: '/articles/linked',
    renderedText: 'Shared title',
  });
  assert.equal(decodeMarker(token).file, 'src/content/articles/linked/index.md');

  await assert.rejects(
    resolveAstroSourceMarker(root, pageFile, '1:41', {
      contextMarker,
      contextHref: '/articles/missing',
      renderedText: 'Shared title',
    }),
    /No linked content frontmatter/,
  );
});

test('rejects unsafe Astro source files and invalid locations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-resolve-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-outside-'));
  await writeFile(path.join(root, 'page.md'), 'Text');
  await writeFile(path.join(root, 'page.astro'), '<p>Text</p>');
  await writeFile(path.join(outside, 'outside.astro'), '<p>Outside</p>');
  await symlink(path.join(outside, 'outside.astro'), path.join(root, 'linked.astro'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));

  await assert.rejects(resolveAstroSourceMarker(root, '../outside.astro', '1:1'), /outside/);
  await assert.rejects(resolveAstroSourceMarker(root, 'linked.astro', '1:1'), /outside/);
  await assert.rejects(resolveAstroSourceMarker(root, 'page.md', '1:1'), /Only Astro/);
  for (const location of ['bad', '0:1', '1:0', '2:1', '1:99']) {
    await assert.rejects(resolveAstroSourceMarker(root, 'page.astro', location), /location is invalid/);
  }
});

test('rejects unresolved linked and contextual frontmatter', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-context-'));
  const pageFile = path.join(root, 'page.astro');
  const markdocFile = path.join(root, 'src/content/articles/markdoc/index.mdoc');
  await mkdir(path.dirname(markdocFile), { recursive: true });
  await writeFile(pageFile, '<h1>{article.data.title}</h1>');
  await writeFile(markdocFile, '---\ntitle: Title\n---\n');
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    resolveAstroSourceMarker(root, pageFile, '1:10', { contextHref: '/', renderedText: 'Title' }),
    /could not be identified/,
  );
  for (const contextHref of ['/articles/missing', '/articles/markdoc']) await assert.rejects(
    resolveAstroSourceMarker(root, pageFile, '1:10', { contextHref, renderedText: 'Title' }),
    /No linked content frontmatter/,
  );
  const astroContext = encodeMarker(createMarker('page.astro', 0, 1, '<', 'astro', 'p'));
  await assert.rejects(
    resolveAstroSourceMarker(root, pageFile, '1:10', {
      contextMarker: astroContext,
      renderedText: 'Title',
    }),
    /could not be identified/,
  );
});

test('validates contextual frontmatter files and rendered values', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-context-'));
  const pageFile = path.join(root, 'src/page.astro');
  await mkdir(path.dirname(pageFile), { recursive: true });
  await writeFile(pageFile, '<h1>{article.data.title}</h1>');
  const cases = [
    ['outside', '../outside.md', '', /outside/],
    ['extension', 'content.txt', '---\ntitle: Title\n---\n', /no editable frontmatter/],
    ['markdoc', 'content.mdoc', '---\ntitle: Title\n---\n', /no editable frontmatter/],
    ['frontmatter', 'plain.md', 'Body', /no editable frontmatter/],
    ['field', 'missing.md', '---\ndescription: Text\n---\n', /field was not found/],
    ['mismatch', 'mismatch.md', '---\ntitle: Other\n---\n', /does not match/],
  ] as const;
  for (const [, relative, source] of cases.slice(1)) await writeFile(path.join(root, relative), source);
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [, relative, , error] of cases) {
    const context = encodeMarker(createMarker(relative, 0, 0, '', 'markdown', 'p'));
    await assert.rejects(
      resolveAstroSourceMarker(root, pageFile, '1:10', { contextMarker: context, renderedText: 'Title' }),
      error,
    );
  }
});

test('rejects contextual frontmatter symlinks that leave the root', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-context-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-outside-'));
  const pageFile = path.join(root, 'page.astro');
  await writeFile(pageFile, '<h1>{article.data.title}</h1>');
  await writeFile(path.join(outside, 'post.md'), '---\ntitle: Title\n---\n');
  await symlink(path.join(outside, 'post.md'), path.join(root, 'post.md'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const context = encodeMarker(createMarker('post.md', 0, 0, '', 'markdown', 'p'));
  await assert.rejects(
    resolveAstroSourceMarker(root, pageFile, '1:10', { contextMarker: context, renderedText: 'Title' }),
    /outside/,
  );
});

test('resolves single-quoted, malformed-double-quoted, and plain frontmatter scalars', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-scalars-'));
  const pageFile = path.join(root, 'page.astro');
  await writeFile(pageFile, '<h1>{article.data.title}</h1>');
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, raw, rendered] of [
    ['single.md', "'Author''s title'", "Author's title"],
    ['broken.md', '"Broken\\x"', 'Broken\\x'],
    ['plain.md', 'Plain title', 'Plain title'],
  ]) {
    await writeFile(path.join(root, name), `---\ntitle: ${raw}\n---\nBody`);
    const context = encodeMarker(createMarker(name, 0, 0, '', 'frontmatter', 'p'));
    const token = await resolveAstroSourceMarker(root, pageFile, '1:10', {
      contextMarker: context,
      renderedText: rendered,
    });
    assert.equal(decodeMarker(token).original, raw);
  }
});

test('handles Astro annotation boundaries and complex opening tags', async () => {
  assert.equal(await annotateAstroSource('<p>Text</p>', '/project', '/project'), null);
  assert.equal(await annotateAstroSource('<p>Text</p>', '/outside/page.astro', '/project'), null);
  assert.equal(await annotateAstroSource('<Component>Text</Component>', '/project/page.astro', '/project'), null);
  const source = '<p title=">" data-value={{ text: ">" }}>Text<!-- note --></p>';
  const transformed = await annotateAstroSource(source, '/project/page.astro?query', '/project');
  assert.match(transformed ?? '', /data-astro-wysiwyg=/);
});

test('annotates positioned Markdown paragraphs and headings', () => {
  const source = '# Heading\n\nText with **weight**.\n';
  const tree = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'h1',
        properties: {},
        children: [{ type: 'text', value: 'Heading' }],
        position: { start: { offset: 0 }, end: { offset: 9 } },
      },
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [{ type: 'text', value: 'Text with ' }, { type: 'element', tagName: 'strong', properties: {}, children: [] }],
        position: { start: { offset: 11 }, end: { offset: 32 } },
      },
    ],
  };
  const transform = rehypeEditableBlocks({ root: '/project' });
  transform(tree, { path: '/project/src/pages/article.md', value: source });

  const heading = tree.children[0];
  const paragraph = tree.children[1];
  const headingToken = String(heading.properties['data-astro-wysiwyg']);
  const paragraphToken = String(paragraph.properties['data-astro-wysiwyg']);
  assert.equal(decodeMarker(headingToken).original, '# Heading');
  assert.equal(decodeMarker(paragraphToken).original, 'Text with **weight**.');
});

test('keeps inserted Astro and Markdown image blocks editable for removal', async () => {
  const astroSource = '<p><img src="/assets/chart.png" alt="Project chart" /></p>';
  const transformed = await annotateAstroSource(astroSource, '/project/page.astro', '/project');
  assert.match(transformed ?? '', /<p data-astro-wysiwyg=/);

  const markdownSource = '![Project chart](/assets/chart.png)';
  const paragraph = {
    type: 'element', tagName: 'p', properties: {},
    position: { start: { offset: 0 }, end: { offset: markdownSource.length } },
    children: [{
      type: 'element', tagName: 'img', properties: { src: '/assets/chart.png', alt: 'Project chart' },
      position: { start: { offset: 0 }, end: { offset: markdownSource.length } },
      children: [],
    }],
  };
  rehypeEditableBlocks({ root: '/project' })(
    { type: 'root', children: [paragraph] },
    { path: '/project/page.md', value: markdownSource },
  );
  const marker = decodeMarker(String(paragraph.properties['data-astro-wysiwyg']));
  assert.equal(marker.original, markdownSource);
  assert.equal(marker.tag, 'p');

  const referenceSource = '![Project chart][chart]';
  const referenceParagraph = {
    type: 'element', tagName: 'p', properties: {},
    position: { start: { offset: 0 }, end: { offset: referenceSource.length } },
    children: [{
      type: 'element', tagName: 'img', properties: {},
      position: { start: { offset: 0 }, end: { offset: referenceSource.length } }, children: [],
    }],
  };
  const missingPositionParagraph = {
    type: 'element', tagName: 'p', properties: {},
    position: { start: { offset: 0 }, end: { offset: referenceSource.length } },
    children: [{ type: 'element', tagName: 'img', properties: {}, children: [] }],
  };
  rehypeEditableBlocks({ root: '/project' })(
    { type: 'root', children: [referenceParagraph, missingPositionParagraph] },
    { path: '/project/page.md', value: referenceSource },
  );
  assert.equal(referenceParagraph.properties['data-astro-wysiwyg'], undefined);
  assert.equal(missingPositionParagraph.properties['data-astro-wysiwyg'], undefined);
});

test('annotates supported Astro, Markdown, and MDX native video figures', async () => {
  const source = '<figure><video controls preload="metadata" aria-label="Project tour" poster="/assets/poster.png" playsinline><source src="/assets/tour.mp4" type="video/mp4" /><track kind="captions" src="/assets/tour.vtt" /></video><figcaption>Project tour description.</figcaption></figure>';
  const astro = await annotateAstroSource(source, '/project/page.astro', '/project');
  assert.match(astro ?? '', /^<figure data-astro-wysiwyg="[A-Za-z0-9_-]+" data-astro-wysiwyg-video>/);
  const astroMarker = decodeMarker(markerFromHtml(astro ?? ''));
  assert.equal(astroMarker.original, source);
  assert.equal(astroMarker.tag, 'figure');
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-video-marker-'));
  const file = path.join(root, 'video.astro');
  await writeFile(file, source);
  const resolved = decodeMarker(await resolveAstroSourceMarker(root, file, '1:20'));
  assert.equal(resolved.original, source);
  assert.equal(resolved.tag, 'figure');
  await rm(root, { recursive: true, force: true });

  const html = {
    type: 'html', value: source,
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  const remarkTransform = remarkEditableMedia({ root: '/project' });
  remarkTransform({ type: 'root', children: [html] }, { path: '/project/page.md', value: source });
  assert.match(html.value, /^<figure data-astro-wysiwyg="[A-Za-z0-9_-]+" data-astro-wysiwyg-video>/);
  assert.equal(decodeMarker(markerFromHtml(html.value)).original, source);
  const untouched = {
    type: 'html', value: 'Plain',
    position: { start: { offset: 0 }, end: { offset: 5 } },
  };
  remarkTransform({ type: 'root', children: [untouched] }, { value: source });
  remarkTransform({ type: 'root', children: [untouched] }, { path: '/outside/page.md', value: source });
  remarkTransform({ type: 'root', children: [untouched] }, { path: '/project/page.md', value: source });
  assert.equal(untouched.value, 'Plain');

  const raw = {
    type: 'raw', value: source,
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  rehypeEditableBlocks({ root: '/project' })(
    { type: 'root', children: [raw] },
    { path: '/project/page.md', value: source },
  );
  assert.match(raw.value, /^<figure data-astro-wysiwyg="[A-Za-z0-9_-]+" data-astro-wysiwyg-video>/);
  assert.equal(decodeMarker(markerFromHtml(raw.value)).original, source);

  const mdxSource = {
    type: 'mdxJsxFlowElement', name: 'figure', attributes: [] as Array<{ type: string; name: string; value: string }>, children: [],
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  remarkEditableMedia({ root: '/project' })(
    { type: 'root', children: [mdxSource] },
    { path: '/project/page.mdx', value: source },
  );
  assert.equal(mdxSource.attributes[0].name, 'data-astro-wysiwyg');
  assert.equal(decodeMarker(mdxSource.attributes[0].value).original, source);
  assert.equal(mdxSource.attributes[1].name, 'data-astro-wysiwyg-video');

  const mdx = {
    type: 'element', tagName: 'figure', properties: {} as Record<string, unknown>, children: [],
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  rehypeEditableBlocks({ root: '/project' })(
    { type: 'root', children: [mdx] },
    { path: '/project/page.mdx', value: source },
  );
  assert.equal(mdx.properties['data-astro-wysiwyg-video'], '');
  assert.equal(decodeMarker(String(mdx.properties['data-astro-wysiwyg'])).original, source);

  const rehypeMdx = {
    type: 'mdxJsxFlowElement', name: 'figure',
    attributes: [] as Array<{ type: string; name: string; value: string }>, children: [],
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  rehypeEditableBlocks({ root: '/project' })(
    { type: 'root', children: [rehypeMdx] },
    { path: '/project/page.mdx', value: source },
  );
  assert.equal(rehypeMdx.attributes[0].name, 'data-astro-wysiwyg');
  assert.equal(rehypeMdx.attributes[1].name, 'data-astro-wysiwyg-video');

  const dynamic = source.replace('src="/assets/tour.mp4"', 'src={tour}');
  assert.doesNotMatch(
    await annotateAstroSource(dynamic, '/project/dynamic.astro', '/project') ?? '',
    /data-astro-wysiwyg-video/,
  );
});

test('annotates supported Astro, Markdown, and MDX native iframes', async (t) => {
  const source = '<iframe src="/embed-preview" title="Project status" width="640" height="360" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts" allow="fullscreen" allowfullscreen></iframe>';
  const astro = await annotateAstroSource(source, '/project/embed.astro', '/project');
  assert.match(astro ?? '', /^<iframe [^>]*data-astro-wysiwyg="[A-Za-z0-9_-]+" data-astro-wysiwyg-iframe>/);
  assert.equal(decodeMarker(markerFromHtml(astro ?? '')).original, source);

  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-iframe-transform-'));
  const file = path.join(root, 'embed.astro');
  await writeFile(file, source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const resolved = await resolveAstroSourceMarker(root, file, '1:10');
  assert.equal(decodeMarker(resolved).tag, 'iframe');

  const html = {
    type: 'html', value: source,
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  remarkEditableMedia({ root: '/project' })(
    { type: 'root', children: [html] },
    { path: '/project/embed.md', value: source },
  );
  assert.match(html.value, /^<iframe data-astro-wysiwyg="[A-Za-z0-9_-]+" data-astro-wysiwyg-iframe /);

  const mdx = {
    type: 'mdxJsxFlowElement', name: 'iframe', attributes: [] as Array<{ type: string; name: string; value: string }>, children: [],
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  remarkEditableMedia({ root: '/project' })(
    { type: 'root', children: [mdx] },
    { path: '/project/embed.mdx', value: source },
  );
  assert.equal(mdx.attributes[1].name, 'data-astro-wysiwyg-iframe');

  const element = {
    type: 'element', tagName: 'iframe', properties: {} as Record<string, unknown>, children: [],
    position: { start: { offset: 0 }, end: { offset: source.length } },
  };
  rehypeEditableBlocks({ root: '/project' })(
    { type: 'root', children: [element] },
    { path: '/project/embed.md', value: source },
  );
  assert.equal(element.properties['data-astro-wysiwyg-iframe'], '');
  assert.equal(decodeMarker(String(element.properties['data-astro-wysiwyg'])).original, source);

  const dynamic = source.replace('src="/embed-preview"', 'src={embedUrl}');
  assert.doesNotMatch(
    await annotateAstroSource(dynamic, '/project/dynamic.astro', '/project') ?? '',
    /data-astro-wysiwyg-iframe/,
  );
});

test('annotates static blockquotes, code blocks, and dividers in Astro, Markdown, and MDX', async (t) => {
  const astroSource = '<blockquote><p>Quote</p></blockquote>\n<pre><code>const x = 1;</code></pre>\n<hr />';
  const astro = await annotateAstroSource(astroSource, '/project/blocks.astro', '/project') ?? '';
  assert.match(astro, /<blockquote data-astro-wysiwyg="[A-Za-z0-9_-]+"><p data-astro-wysiwyg=/);
  assert.match(astro, /<pre data-astro-wysiwyg="[A-Za-z0-9_-]+"><code>/);
  assert.match(astro, /<hr\s+data-astro-wysiwyg="[A-Za-z0-9_-]+"\s*\/>/);
  assert.equal(decodeMarker(markerFromHtml(astro.match(/<blockquote[^>]+>/)![0])).tag, 'blockquote');
  assert.match(await annotateAstroSource('<hr>', '/project/divider.astro', '/project') ?? '', /<hr data-astro-wysiwyg=/);
  const root = await mkdtemp(path.join(tmpdir(), 'astro-wysiwyg-divider-transform-'));
  const dividerFile = path.join(root, 'divider.astro');
  await writeFile(dividerFile, '<hr />');
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(decodeMarker(await resolveAstroSourceMarker(root, dividerFile, '1:2')).tag, 'hr');

  for (const [nodeType, tagName, source] of [
    ['blockquote', 'blockquote', '> Quote'],
    ['code', 'pre', '```\ncode\n```'],
    ['thematicBreak', 'hr', '---'],
  ] as const) {
    const node = {
      type: nodeType,
      data: {} as { hProperties?: Record<string, unknown> },
      position: { start: { offset: 0 }, end: { offset: source.length } },
    };
    const file = { path: '/project/blocks.mdx', value: source, data: {} as { astroWysiwygStaticMarkers?: unknown[] } };
    remarkEditableMedia({ root: '/project' })({ type: 'root', children: [node] }, file);
    assert.equal(decodeMarker(String(node.data.hProperties?.['data-astro-wysiwyg'])).tag, tagName);
    const rendered = { type: 'element', tagName, properties: {} as Record<string, unknown>, children: [] };
    rehypeEditableBlocks({ root: '/project' })({ type: 'root', children: [rendered] }, file);
    assert.equal(decodeMarker(String(rendered.properties['data-astro-wysiwyg'])).tag, tagName);
  }

  for (const [tagName, source, children] of [
    ['blockquote', '> Quote', [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'Quote' }] }]],
    ['pre', '```\ncode\n```', [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: 'code' }] }]],
    ['hr', '---', []],
  ] as const) {
    const node = {
      type: 'element', tagName, properties: {} as Record<string, unknown>, children,
      position: { start: { offset: 0 }, end: { offset: source.length } },
    };
    rehypeEditableBlocks({ root: '/project' })(
      { type: 'root', children: [node] },
      { path: '/project/blocks.md', value: source },
    );
    assert.equal(decodeMarker(String(node.properties['data-astro-wysiwyg'])).tag, tagName);
  }

  const dynamic = '<blockquote><p>{quote}</p></blockquote>\n<hr class={dividerClass} />';
  assert.doesNotMatch(await annotateAstroSource(dynamic, '/project/dynamic.astro', '/project') ?? '', /data-astro-wysiwyg/);
});

test('annotates a static Markdown list as one editable block', () => {
  const source = '- First item';
  const tree = {
    type: 'root',
    children: [{
      type: 'element', tagName: 'ul', properties: {},
      position: { start: { offset: 0 }, end: { offset: source.length } },
      children: [{
        type: 'element', tagName: 'li', properties: {},
        children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'First item' }] }],
        position: { start: { offset: 0 }, end: { offset: source.length } },
      }],
    }],
  };
  rehypeEditableBlocks({ root: '/project' })(tree, { path: '/project/list.md', value: source });

  assert.equal(decodeMarker(String(tree.children[0].properties['data-astro-wysiwyg'])).tag, 'ul');
  assert.equal(tree.children[0].children[0].properties['data-astro-wysiwyg'], undefined);
});

test('skips unsafe and incomplete Markdown nodes while creating missing properties', () => {
  const transform = rehypeEditableBlocks({ root: '/project' });
  const paragraph = {
    type: 'element', tagName: 'p',
    children: [{ type: 'element', tagName: 'em', children: [{ type: 'text', value: 'Text' }] }],
    position: { start: { offset: 0 }, end: { offset: 4 } },
  };
  const tree = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'aside', children: [], position: { start: { offset: 0 }, end: { offset: 4 } } },
      { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'No position' }] },
      { type: 'element', tagName: 'p', position: { start: { offset: 0 }, end: { offset: 4 } } },
      { type: 'element', tagName: 'p', children: [{ type: 'element', tagName: 'em' }], position: { start: { offset: 0 }, end: { offset: 4 } } },
      { type: 'element', tagName: 'p', children: [{ type: 'text', value: '' }], position: { start: { offset: 0 }, end: { offset: 0 } } },
      paragraph,
    ],
  };

  transform(tree, { value: 'Text' });
  transform(tree, { path: '/outside/page.md', value: 'Text' });
  transform(tree, { path: '/project/page.md', value: 'Text' });

  assert.ok(paragraph.properties);
  assert.match(String(paragraph.properties['data-astro-wysiwyg']), /.+/);
});

test('skips Markdown constructs that Turndown cannot round-trip safely', () => {
  const source = 'Footnote[^1].\n\n[^1]: Footnote text.\n\nSee [guide][docs].\n\nSafe [link](/docs) and **bold**.\n';
  const footnoteReference = {
    type: 'element', tagName: 'p', properties: {},
    position: { start: { offset: 0 }, end: { offset: 13 } },
    children: [
      { type: 'text', value: 'Footnote' },
      { type: 'element', tagName: 'sup', properties: {}, children: [{
        type: 'element', tagName: 'a', properties: { dataFootnoteRef: true },
        position: { start: { offset: 8 }, end: { offset: 12 } },
        children: [{ type: 'text', value: '1' }],
      }] },
      { type: 'text', value: '.' },
    ],
  };
  const definitionStart = source.indexOf('Footnote text.');
  const footnoteDefinition = {
    type: 'element', tagName: 'p', properties: {},
    position: { start: { offset: definitionStart }, end: { offset: definitionStart + 14 } },
    children: [
      { type: 'text', value: 'Footnote text. ' },
      { type: 'element', tagName: 'a', properties: { dataFootnoteBackref: '' }, children: [{ type: 'text', value: '↩' }] },
    ],
  };
  const referenceStart = source.indexOf('See [guide][docs].');
  const referenceLink = {
    type: 'element', tagName: 'p', properties: {},
    position: { start: { offset: referenceStart }, end: { offset: referenceStart + 18 } },
    children: [
      { type: 'text', value: 'See ' },
      { type: 'element', tagName: 'a', properties: { href: '/docs' },
        position: { start: { offset: referenceStart + 4 }, end: { offset: referenceStart + 17 } },
        children: [{ type: 'text', value: 'guide' }] },
      { type: 'text', value: '.' },
    ],
  };
  const safeStart = source.indexOf('Safe [link](/docs) and **bold**.');
  const safe = {
    type: 'element', tagName: 'p', properties: {},
    position: { start: { offset: safeStart }, end: { offset: source.length - 1 } },
    children: [
      { type: 'text', value: 'Safe ' },
      { type: 'element', tagName: 'a', properties: { href: '/docs' },
        position: { start: { offset: safeStart + 5 }, end: { offset: safeStart + 18 } },
        children: [{ type: 'text', value: 'link' }] },
      { type: 'text', value: ' and ' },
      { type: 'element', tagName: 'strong', properties: {}, children: [{ type: 'text', value: 'bold' }] },
      { type: 'text', value: '.' },
    ],
  };
  const tree = { type: 'root', children: [footnoteReference, footnoteDefinition, referenceLink, safe] };

  rehypeEditableBlocks({ root: '/project' })(tree, { path: '/project/page.md', value: source });

  assert.equal(footnoteReference.properties['data-astro-wysiwyg'], undefined);
  assert.equal(footnoteDefinition.properties['data-astro-wysiwyg'], undefined);
  assert.equal(referenceLink.properties['data-astro-wysiwyg'], undefined);
  assert.match(String(safe.properties['data-astro-wysiwyg']), /.+/);
});

test('does not annotate Markdown blocks containing MDX components', () => {
  const source = 'Text <Widget />';
  const tree = {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'text', value: 'Text ' }, { type: 'mdxJsxTextElement', name: 'Widget', children: [] }],
      position: { start: { offset: 0 }, end: { offset: source.length } },
    }],
  };
  const transform = rehypeEditableBlocks({ root: '/project' });
  transform(tree, { path: '/project/src/pages/article.mdx', value: source });

  assert.equal(tree.children[0].properties['data-astro-wysiwyg'], undefined);
});
