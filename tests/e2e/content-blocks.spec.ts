import { expect, test } from './coverage.ts';
import { readFile, writeFile } from 'node:fs/promises';

const markdownFile = '.tmp/e2e-site/src/pages/content-blocks.md';
const astroFile = '.tmp/e2e-site/src/pages/content-blocks-astro.astro';
const mdxFile = '.tmp/e2e-site/src/pages/content-blocks-mdx.mdx';

test('inserts and undoes every registered static content type from one picker', async ({ page }) => {
  const original = await readFile(markdownFile, 'utf8');
  await page.goto('/content-blocks');
  const target = page.getByText('Select this stable insertion target', { exact: false });
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const types = [
    ['Paragraph below', 'P', 'New paragraph'],
    ['Heading', 'H2', 'New heading'],
    ['Bulleted list', 'UL', 'New item'],
    ['Numbered list', 'OL', 'New item'],
    ['Blockquote', 'BLOCKQUOTE', 'New quote'],
    ['Code block', 'PRE', 'New code'],
    ['Divider', 'HR', ''],
  ] as const;

  for (const [label, tag, text] of types) {
    await target.click();
    await editor.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(editor.getByText('Only static source-backed blocks valid in this file')).toBeVisible();
    await editor.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('Block added');
    const inserted = target.locator('xpath=following-sibling::*[1]');
    await expect(inserted).toHaveJSProperty('tagName', tag);
    if (text) await expect(inserted).toContainText(text);
    await expect(editor.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Undo' }).click();
    await expect(editor.locator('[role="status"]')).toHaveText('Inserted block removed');
    await expect.poll(async () => readFile(markdownFile, 'utf8')).toBe(original);
  }

  await target.click();
  await editor.getByRole('button', { name: 'Insert', exact: true }).click();
  await editor.getByRole('menuitem', { name: 'Paragraph below' }).click();
  const detached = page.getByText('New paragraph', { exact: true });
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === 'delete') await deleteGate;
    await route.continue();
  });
  const undo = editor.getByRole('button', { name: 'Undo' }).click();
  await expect(editor.getByRole('status')).toHaveText('Removing inserted block...');
  await detached.evaluate((element) => element.remove());
  releaseDelete();
  await undo;
  await page.unroute('**/_astro-wysiwyg/save');
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toBe(original);
});

test('replaces, confirms loss, restores formatting, and keeps failed source unchanged', async ({ page }) => {
  const original = await readFile(markdownFile, 'utf8');
  await page.goto('/content-blocks');
  const editor = page.locator('#astro-wysiwyg-toolbar');

  const heading = page.getByRole('heading', { name: 'Replaceable heading' });
  await heading.click();
  const replace = editor.getByRole('button', { name: 'Replace block' });
  await expect(replace).toBeVisible();
  await replace.focus();
  await replace.press('ArrowDown');
  const replaceMenu = editor.getByRole('menu', { name: 'Replace block' });
  await expect(replaceMenu.getByRole('menuitem', { name: 'Replace with paragraph' })).toBeFocused();
  await replaceMenu.getByRole('menuitem', { name: 'Replace with paragraph' }).click();
  await expect(editor.getByRole('status')).toHaveText('Block replaced');
  await expect(page.locator('main > p').filter({ hasText: 'Replaceable heading' })).toBeVisible();
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(editor.getByRole('status')).toHaveText('Block restored');
  await expect(page.getByRole('heading', { name: 'Replaceable heading' })).toBeVisible();
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toBe(original);

  const formatted = page.getByText('This paragraph keeps inline emphasis', { exact: false });
  await formatted.click();
  await replace.click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await replaceMenu.getByRole('menuitem', { name: 'Replace with code block' }).click();
  await expect(editor.getByRole('status')).toHaveText('Block replacement cancelled');
  expect(await readFile(markdownFile, 'utf8')).toBe(original);

  await replace.click();
  page.once('dialog', (dialog) => dialog.accept());
  await replaceMenu.getByRole('menuitem', { name: 'Replace with code block' }).click();
  await expect(editor.getByRole('status')).toHaveText('Block replaced');
  await expect(page.locator('pre').filter({ hasText: 'This paragraph keeps inline emphasis' })).toBeVisible();
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(editor.getByRole('status')).toHaveText('Block restored');
  await expect(page.getByText('inline emphasis', { exact: true })).toHaveCSS('font-weight', /^(?:600|700|bold)$/);
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toBe(original);

  const list = page.locator('main > ul').filter({ hasText: 'First bulleted item' });
  await list.click();
  await replace.click();
  page.once('dialog', (dialog) => dialog.accept());
  await replaceMenu.getByRole('menuitem', { name: 'Replace with paragraph' }).click();
  await expect(page.locator('main > p').filter({ hasText: 'First bulleted item' })).toContainText('Second bulleted item');
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('main > ul').filter({ hasText: 'First bulleted item' })).toBeVisible();
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toBe(original);

  const quote = page.locator('main > blockquote');
  await quote.click();
  await replace.click();
  page.once('dialog', (dialog) => dialog.accept());
  await replaceMenu.getByRole('menuitem', { name: 'Replace with paragraph' }).click();
  await expect(editor.getByRole('status')).toHaveText('Block replaced');
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('main > blockquote')).toBeVisible();

  const code = page.locator('main > pre');
  await code.evaluate((element) => {
    delete element.dataset.language;
    element.querySelector('code')!.className = 'language-text';
  });
  await code.click();
  await replace.click();
  page.once('dialog', (dialog) => dialog.accept());
  await replaceMenu.getByRole('menuitem', { name: 'Replace with paragraph' }).click();
  await expect(editor.getByRole('status')).toHaveText('Block replaced');
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('main > pre')).toContainText('const stable = true;');
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toBe(original);

  await page.getByRole('heading', { name: 'Replaceable heading' }).click();
  await replace.click();
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'The source changed before block replacement.' }) });
  });
  await replaceMenu.getByRole('menuitem', { name: 'Replace with paragraph' }).click();
  await expect(editor.getByRole('status')).toHaveText('The source changed before block replacement.');
  await page.unroute('**/_astro-wysiwyg/save');
  expect(await readFile(markdownFile, 'utf8')).toBe(original);
});

test('recognizes safe static targets in Astro and MDX while dynamic content stays read-only', async ({ page }) => {
  const originalAstro = await readFile(astroFile, 'utf8');
  const originalMdx = await readFile(mdxFile, 'utf8');
  const editor = page.locator('#astro-wysiwyg-toolbar');

  await page.goto('/content-blocks-astro');
  await page.getByText('Static Astro quote').click();
  await expect(editor.getByRole('button', { name: 'Replace block' })).toBeVisible();
  await expect(page.locator('blockquote')).toHaveAttribute('contenteditable', 'false');
  await page.locator('main > pre').click();
  await expect(editor.getByRole('button', { name: 'Replace block' })).toBeVisible();
  await expect(page.locator('main > pre')).toHaveAttribute('contenteditable', 'false');

  await page.locator('main > hr').click();
  await expect(editor.getByRole('status')).toHaveText('Static block selected');
  await editor.getByRole('button', { name: 'Replace block' }).click();
  await editor.getByRole('menuitem', { name: 'Replace with paragraph' }).click();
  await expect(page.locator('main > p').filter({ hasText: 'New paragraph' })).toBeVisible();
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('main > hr')).toBeVisible();
  await expect.poll(async () => readFile(astroFile, 'utf8')).toBe(originalAstro);

  await page.locator('blockquote').evaluate((element) => {
    const marker = element.getAttribute('data-astro-wysiwyg')!;
    element.querySelector('p')!.setAttribute('data-astro-wysiwyg', marker);
    document.dispatchEvent(new Event('astro:page-load'));
  });
  await expect(page.locator('blockquote > p')).not.toHaveAttribute('data-astro-wysiwyg');
  await page.locator('main > pre').evaluate((element) => {
    const code = element.querySelector('code')!;
    code.setAttribute('data-astro-wysiwyg', element.getAttribute('data-astro-wysiwyg')!);
    element.removeAttribute('data-astro-wysiwyg');
    document.dispatchEvent(new Event('astro:page-load'));
  });
  await expect(page.locator('main > pre')).toHaveAttribute('data-astro-wysiwyg', /.+/);
  await page.locator('main > pre').evaluate((element) => {
    const code = element.querySelector('code')!;
    code.setAttribute('data-astro-wysiwyg', element.getAttribute('data-astro-wysiwyg')!);
    code.click();
  });

  await page.goto('/content-blocks-mdx');
  await page.locator('main > pre').evaluate((element) => element.click());
  await expect(editor.getByRole('button', { name: 'Replace block' })).toBeVisible();
  await expect(page.locator('main > pre')).toHaveAttribute('contenteditable', 'false');
  await editor.getByRole('button', { name: 'Replace block' }).evaluate((button) => button.click());
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('menuitem', { name: 'Replace with paragraph' }).evaluate((button) => button.click());
  await expect(editor.getByRole('status')).toHaveText('Block replaced');
  await editor.getByRole('button', { name: 'Undo' }).evaluate((button) => button.click());
  await expect(page.locator('main > pre')).toContainText('const mdx = true;');
  await expect.poll(async () => readFile(mdxFile, 'utf8')).toBe(originalMdx);

  await page.goto('/');
  await page.getByText('Dynamic text stays source-safe', { exact: true }).click();
  await expect(editor.getByRole('toolbar')).toBeHidden();

  await writeFile(astroFile, originalAstro);
  await writeFile(mdxFile, originalMdx);
});
