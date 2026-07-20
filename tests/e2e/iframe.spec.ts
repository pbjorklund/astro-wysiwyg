import { expect, test } from './coverage.ts';
import { readFile, writeFile } from 'node:fs/promises';

const markdownFile = '.tmp/e2e-site/src/pages/iframes.md';
const astroFile = '.tmp/e2e-site/src/pages/iframe-astro.astro';
const mdxFile = '.tmp/e2e-site/src/pages/iframe-mdx.mdx';

test('previews, cancels, and inserts a validated same-origin iframe', async ({ page }) => {
  const original = await readFile(markdownFile, 'utf8');
  await page.goto('/iframes');
  const target = page.getByText('Insert a same-origin or explicitly approved HTTPS iframe', { exact: false });
  await target.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const open = async () => {
    await editor.getByRole('button', { name: 'Insert', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Iframe embed' }).click();
    return editor.getByRole('dialog', { name: 'Insert iframe' });
  };

  let dialog = await open();
  await expect(dialog.getByText('Allowed sources: self.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await dialog.getByLabel('Embed URL').fill('/embed-preview');
  await dialog.getByLabel('Accessible title').fill('Cancelled status embed');
  await dialog.evaluate((element) => element.dispatchEvent(new Event('cancel', { cancelable: true })));
  await expect(dialog).not.toBeVisible();
  await expect(editor.getByRole('button', { name: 'Insert', exact: true })).toBeFocused();
  expect(await readFile(markdownFile, 'utf8')).toBe(original);

  dialog = await open();
  await dialog.press('Escape');
  await expect(dialog).not.toBeVisible();
  dialog = await open();
  await page.route('**/_astro-wysiwyg/save/iframes/preview', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await dialog.getByLabel('Embed URL').fill('/embed-preview');
  await dialog.getByLabel('Accessible title').fill('Unavailable preview');
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The iframe could not be previewed.');
  await page.unroute('**/_astro-wysiwyg/save/iframes/preview');
  await dialog.getByLabel('Embed URL').fill('https://unapproved.example/embed');
  await dialog.getByLabel('Accessible title').fill('Unsafe provider');
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('This iframe provider is not approved.');
  await dialog.getByLabel('Embed URL').fill('/embed-preview');
  await dialog.getByLabel('Accessible title').fill('Inserted project status');
  await dialog.getByLabel('Width').fill('640');
  await dialog.getByLabel('Height').fill('240');
  await dialog.getByLabel('Loading').selectOption('eager');
  await dialog.getByLabel('Referrer policy').selectOption('no-referrer');
  await dialog.getByLabel('Scripts').check();
  await dialog.getByLabel('Same origin').check();
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Same-origin iframes cannot combine allow-scripts with allow-same-origin.',
  );
  await dialog.getByLabel('Same origin').uncheck();
  await dialog.getByLabel('Fullscreen permission').check();
  await dialog.getByLabel('Fullscreen attribute').check();
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Iframe validated. Review the preview, then save it.');
  await expect(dialog.locator('[data-iframe-preview]')).toHaveAttribute('src', '/embed-preview');
  await expect(dialog.locator('[data-iframe-preview]')).toHaveAttribute('sandbox', 'allow-scripts');
  await dialog.getByLabel('Accessible title').fill('Changed after preview');
  await expect(dialog.getByRole('button', { name: 'Insert iframe' })).toBeDisabled();
  await dialog.getByLabel('Accessible title').fill('Inserted project status');
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await dialog.getByRole('button', { name: 'Insert iframe' }).click();
  await expect(dialog).not.toBeVisible();

  const inserted = page.locator('iframe[title="Inserted project status"]');
  await expect(inserted).toHaveAttribute('width', '640');
  await expect(inserted).toHaveAttribute('height', '240');
  await expect(inserted).toHaveAttribute('loading', 'eager');
  await expect(inserted).toHaveAttribute('allow', 'fullscreen');
  await expect(inserted).toHaveAttribute('allowfullscreen', '');
  await expect(page.getByRole('button', { name: 'Edit iframe: Inserted project status' })).toBeVisible();
  await page.evaluate(() => {
    const emptyShell = document.createElement('span');
    emptyShell.dataset.astroWysiwygIframeShell = '';
    document.body.append(emptyShell);
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: false, autosave: true, highlights: true },
    }));
  });
  await expect(page.locator('[data-astro-wysiwyg-iframe-shell]')).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
    detail: { enabled: true, autosave: true, highlights: true },
  })));
  await expect(page.getByRole('button', { name: 'Edit iframe: Inserted project status' })).toBeVisible();
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain(
    '<iframe src="/embed-preview" title="Inserted project status" width="640" height="240" loading="eager" referrerpolicy="no-referrer" sandbox="allow-scripts" allow="fullscreen" allowfullscreen></iframe>',
  );
  await page.reload();
  await expect(page.locator('iframe[title="Inserted project status"]')).toBeVisible();
  await writeFile(markdownFile, original);
});

test('updates static Markdown, Astro, and MDX iframes without changing surrounding source', async ({ page }) => {
  const originalMarkdown = await readFile(markdownFile, 'utf8');
  const originalAstro = await readFile(astroFile, 'utf8');
  const originalMdx = await readFile(mdxFile, 'utf8');
  await page.goto('/iframes');
  await page.getByRole('button', { name: 'Edit iframe: Local project status' }).click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await expect(editor.getByRole('button', { name: 'Bold' })).toBeDisabled();
  const edit = editor.getByRole('button', { name: 'Edit iframe', exact: true });
  await expect(edit).toBeVisible();
  await edit.click();
  let dialog = editor.getByRole('dialog', { name: 'Edit iframe' });
  await expect(dialog.getByLabel('Embed URL')).toHaveValue('/embed-preview');
  await expect(dialog.getByLabel('Accessible title')).toHaveValue('Local project status');
  await expect(dialog.getByLabel('Scripts')).toBeChecked();
  await dialog.getByLabel('Accessible title').fill('Updated Markdown status');
  await dialog.getByLabel('Width').fill('720');
  await dialog.getByLabel('Height').fill('260');
  await dialog.getByLabel('Clipboard write').check();
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await dialog.getByRole('button', { name: 'Edit iframe' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('iframe[title="Updated Markdown status"]')).toHaveAttribute('allow', 'clipboard-write');
  const saved = await readFile(markdownFile, 'utf8');
  expect(saved).toContain('title="Updated Markdown status" width="720" height="260"');
  expect(saved).toContain('The paragraph after the fixture proves');

  await page.goto('/iframe-astro');
  await page.getByRole('button', { name: 'Edit iframe: Astro project status' }).click();
  await expect(editor.getByRole('button', { name: 'Edit iframe', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Edit iframe', exact: true }).click();
  dialog = editor.getByRole('dialog', { name: 'Edit iframe' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor.getByRole('button', { name: 'Edit iframe', exact: true })).toBeFocused();
  expect(await readFile(astroFile, 'utf8')).toBe(originalAstro);

  await page.goto('/iframe-mdx');
  await page.getByRole('button', { name: 'Edit iframe: MDX project status' }).click();
  await expect(editor.getByRole('button', { name: 'Edit iframe', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Edit iframe', exact: true }).click();
  dialog = editor.getByRole('dialog', { name: 'Edit iframe' });
  await dialog.getByLabel('Accessible title').fill('Updated MDX status');
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await dialog.getByRole('button', { name: 'Edit iframe' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The iframe could not be updated.');
  await page.unroute('**/_astro-wysiwyg/save');
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'The source changed before iframe replacement.' }) });
  });
  await dialog.getByRole('button', { name: 'Edit iframe' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The source changed before iframe replacement.');
  await expect(dialog).toBeVisible();
  await page.unroute('**/_astro-wysiwyg/save');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await readFile(mdxFile, 'utf8')).toBe(originalMdx);

  await writeFile(markdownFile, originalMarkdown);
  await writeFile(astroFile, originalAstro);
  await writeFile(mdxFile, originalMdx);
});

test('keeps iframe dialog failures and detached insertion recoverable', async ({ page }) => {
  const original = await readFile(markdownFile, 'utf8');
  await page.goto('/iframes');
  const target = page.getByText('Insert a same-origin or explicitly approved HTTPS iframe', { exact: false });
  await target.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const hiddenReplace = editor.locator('[data-action="replace-iframe"]');
  await hiddenReplace.evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })));
  await editor.getByRole('button', { name: 'Insert', exact: true }).click();
  await editor.getByRole('menuitem', { name: 'Iframe embed' }).click();
  let dialog = editor.getByRole('dialog', { name: 'Insert iframe' });
  await dialog.getByLabel('Embed URL').fill('/embed-preview');
  await dialog.getByLabel('Accessible title').fill('Detached project status');
  let releasePreview!: () => void;
  let previewStarted!: () => void;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  const previewRequestStarted = new Promise<void>((resolve) => { previewStarted = resolve; });
  await page.route('**/_astro-wysiwyg/save/iframes/preview', async (route) => {
    previewStarted();
    await previewGate;
    await route.continue();
  });
  const staleResponse = page.waitForResponse((response) => response.url().endsWith('/_astro-wysiwyg/save/iframes/preview'));
  const stalePreview = dialog.getByRole('button', { name: 'Preview iframe' }).click();
  await previewRequestStarted;
  await dialog.getByLabel('Accessible title').fill('Changed without preview');
  releasePreview();
  await stalePreview;
  await staleResponse;
  await expect(dialog.getByRole('alert')).toHaveText('Preview the validated iframe before saving.');
  await page.unroute('**/_astro-wysiwyg/save/iframes/preview');
  await dialog.getByRole('button', { name: 'Insert iframe' }).evaluate((button) => (
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
  ));
  await expect(dialog.getByRole('alert')).toHaveText('Preview the validated iframe before saving.');

  await dialog.getByLabel('Accessible title').fill('Detached project status');
  await dialog.getByRole('button', { name: 'Preview iframe' }).click();
  const marker = await target.getAttribute('data-astro-wysiwyg');
  const sourceFile = await target.getAttribute('data-wysiwyg-source-file');
  const sourceLoc = await target.getAttribute('data-wysiwyg-source-loc');
  await target.evaluate((element) => {
    element.removeAttribute('data-astro-wysiwyg');
    element.removeAttribute('data-wysiwyg-source-file');
    element.removeAttribute('data-wysiwyg-source-loc');
  });
  await dialog.getByRole('button', { name: 'Insert iframe' }).click();
  await expect(editor.getByRole('status')).toHaveText('Frontmatter fields cannot be added or deleted.');
  await target.evaluate((element, values) => {
    element.setAttribute('data-astro-wysiwyg', values.marker!);
    element.setAttribute('data-wysiwyg-source-file', values.sourceFile!);
    element.setAttribute('data-wysiwyg-source-loc', values.sourceLoc!);
  }, { marker, sourceFile, sourceLoc });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await dialog.getByRole('button', { name: 'Insert iframe' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The iframe could not be inserted.');
  await page.unroute('**/_astro-wysiwyg/save');

  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    started();
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ marker: 'detached-iframe-marker' }) });
  });
  await dialog.getByRole('button', { name: 'Insert iframe' }).click();
  await requestStarted;
  await target.evaluate((element) => element.remove());
  release();
  await expect(dialog).not.toBeVisible();
  await page.unroute('**/_astro-wysiwyg/save');
  expect(await readFile(markdownFile, 'utf8')).toBe(original);

  await page.reload();
  await page.getByRole('button', { name: 'Edit iframe: Local project status' }).click();
  await editor.getByRole('button', { name: 'Edit iframe', exact: true }).click();
  dialog = editor.getByRole('dialog', { name: 'Edit iframe' });
  await target.evaluate((element) => element.click());
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Edit iframe: Local project status' }).click();
  await editor.getByRole('button', { name: 'Edit iframe', exact: true }).click();
  await editor.getByRole('button', { name: 'Done' }).evaluate((button) => button.click());
  await expect(dialog).not.toBeVisible();
});
