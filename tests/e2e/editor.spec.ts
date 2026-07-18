import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const astroFile = '.tmp/e2e-site/src/pages/index.astro';
const markdownFile = '.tmp/e2e-site/src/pages/article.md';
const cardFile = '.tmp/e2e-site/src/content/articles/example/index.md';
const linkFile = '.tmp/e2e-site/src/pages/links.md';
const listFile = '.tmp/e2e-site/src/pages/lists.md';

test('edits an Astro block with keyboard formatting and saves to disk', async ({ page }) => {
  await page.goto('/');
  const paragraph = page.locator('p.lead');
  await expect(paragraph).toHaveAttribute('data-wysiwyg-source-loc', /.+/);
  const before = await paragraph.evaluate((element) => ({
    color: getComputedStyle(element).color,
    font: getComputedStyle(element).fontFamily,
  }));

  await paragraph.click();
  await expect(paragraph).toHaveAttribute('data-astro-wysiwyg', /.+/);
  const editorToolbar = page.locator('#astro-wysiwyg-toolbar').locator('[role="toolbar"]');
  await expect(editorToolbar).toBeVisible();
  await paragraph.press('Alt+F10');
  await expect(editorToolbar.getByRole('button', { name: 'Bold' })).toBeFocused();
  await paragraph.click();
  await paragraph.press('Control+a');
  await paragraph.pressSequentially('Saved from the browser');
  await paragraph.press('Control+a');
  await paragraph.press('Control+b');
  await expect(paragraph.locator('b, strong')).toHaveText('Saved from the browser');

  const after = await paragraph.evaluate((element) => ({
    color: getComputedStyle(element).color,
    font: getComputedStyle(element).fontFamily,
    className: element.className,
  }));
  expect(after).toEqual({ ...before, className: 'lead' });
  await expect.poll(async () => readFile(astroFile, 'utf8')).toContain(
    '<p class="lead"><b>Saved from the browser</b></p>',
  );

  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await paragraph.press('Alt+1');
  await expect.poll(async () => readFile(astroFile, 'utf8')).toContain(
    '<h1 class="lead"><b>Saved from the browser</b></h1>',
  );
  await expect(page.locator('h1.lead')).toContainText('Saved from the browser');
});

test('edits a rendered frontmatter title without leaving edit mode', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('wysiwyg-loads', String(Number(sessionStorage.getItem('wysiwyg-loads') ?? 0) + 1));
  });
  await page.goto('/article');
  const title = page.locator('h1.frontmatter-title');
  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.press('End');
  await title.pressSequentially(' updated');

  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('title: Markdown fixture updated');
  await page.waitForTimeout(2_000);
  await expect(title).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('wysiwyg-loads'))).toBe('2');

  await page.reload();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('wysiwyg-loads'))).toBe('3');
});

test('edits article frontmatter from the toolbar form', async ({ page }) => {
  await page.goto('/article');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Frontmatter' }).click();
  const dialog = editor.getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'title' }).fill('Edited in frontmatter');
  await dialog.getByRole('textbox', { name: 'tags' }).fill('astro, editing');
  await dialog.getByLabel('publishedAt').fill('2026-08-01');
  await dialog.getByRole('checkbox', { name: 'aiDisclaimer' }).check();
  await dialog.getByRole('button', { name: 'Save frontmatter' }).click();

  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('title: Edited in frontmatter');
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('publishedAt: 2026-08-01');
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('tags: ["astro","editing"]');
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('aiDisclaimer: true');
});

test('queues continued Markdown edits behind an in-flight save', async ({ page }) => {
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    saveRequests += 1;
    if (saveRequests === 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await page.goto('/article');
  const paragraph = page.locator('main > p');
  await expect(paragraph).toHaveAttribute('data-astro-wysiwyg', /.+/);
  await paragraph.click();
  await paragraph.press('Control+a');
  await paragraph.pressSequentially('Markdown');
  await page.waitForTimeout(550);
  await paragraph.pressSequentially(' saved');
  await paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error('Missing paragraph text');
    const range = document.createRange();
    range.setStart(text, 9);
    range.setEnd(text, 14);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await paragraph.press('Control+b');

  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('Markdown **saved**');
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
});

test('leaves dynamic Astro expressions uneditable', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('p').filter({ hasText: 'Dynamic text' })).not.toHaveAttribute('data-astro-wysiwyg', /.+/);
});

test('edits rendered card frontmatter through its article link', async ({ page }) => {
  await page.goto('/cards');
  const title = page.locator('h2.card-title');
  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.press('Control+a');
  await title.pressSequentially('Edited rendered card');
  await expect.poll(async () => readFile(cardFile, 'utf8')).toContain('title: "Edited rendered card"');
  await expect(title).toHaveAttribute('contenteditable', 'true');
});

test('adds and edits a Markdown hyperlink from the toolbar', async ({ page }) => {
  await page.goto('/links');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error('Missing link fixture text');
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 16);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Link' }).click();
  await editor.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/docs');
  await editor.getByRole('button', { name: 'Apply link' }).click();
  await expect.poll(async () => readFile(linkFile, 'utf8')).toContain(
    '[this phrase](https://example.com/docs)',
  );

  await page.waitForTimeout(2_500);
  const link = page.locator('main > p a');
  await link.click();
  await editor.getByRole('button', { name: 'Link' }).click();
  await expect(editor.getByRole('textbox', { name: 'Link URL' })).toHaveValue('https://example.com/docs');
  await editor.getByRole('textbox', { name: 'Link URL' }).fill('/updated');
  await editor.getByRole('button', { name: 'Apply link' }).click();
  await expect.poll(async () => readFile(linkFile, 'utf8')).toContain('[this phrase](/updated)');
});

test('changes a Markdown paragraph between bullet and numbered lists', async ({ page }) => {
  await page.goto('/lists');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Bullet list' }).click();
  await expect.poll(async () => readFile(listFile, 'utf8')).toContain('- Turn this paragraph into a list.');

  await page.waitForTimeout(2_500);
  const list = page.locator('main > ul');
  await expect(list).toHaveAttribute('contenteditable', 'true');
  await editor.getByRole('button', { name: 'Numbered list' }).click();
  await expect.poll(async () => readFile(listFile, 'utf8')).toContain('1. Turn this paragraph into a list.');
});

test('undoes a saved card edit after Astro reloads', async ({ page }) => {
  const before = await readFile(cardFile, 'utf8');
  await page.goto('/cards');
  const title = page.locator('h2.card-title');
  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await title.press('Control+a');
  await title.pressSequentially('Undo candidate');
  await expect.poll(async () => readFile(cardFile, 'utf8')).toContain('title: "Undo candidate"');
  await page.waitForTimeout(2_500);
  await page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => readFile(cardFile, 'utf8')).toBe(before);
});

test('applies enable, autosave, and outline preferences', async ({ page }) => {
  await page.goto('/');
  const heading = page.locator('main > h1').first();
  await page.evaluate(() => {
    const preferences = { enabled: false, autosave: true, highlights: true };
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify(preferences));
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', { detail: preferences }));
  });
  await heading.click();
  await expect(heading).not.toHaveAttribute('contenteditable', 'true');

  await page.evaluate(() => {
    const preferences = { enabled: true, autosave: false, highlights: false };
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify(preferences));
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', { detail: preferences }));
  });
  await heading.click();
  await expect(heading).toHaveAttribute('contenteditable', 'true');
  await heading.press('Control+a');
  await heading.pressSequentially('Saved manually');
  await page.waitForTimeout(700);
  expect(await readFile(astroFile, 'utf8')).not.toContain('Saved manually');
  await heading.press('Control+s');
  await expect.poll(async () => readFile(astroFile, 'utf8')).toContain('Saved manually');
  await expect(page.locator('html')).not.toHaveAttribute('data-astro-wysiwyg-highlights', '');
});
