import { readFile } from 'node:fs/promises';
import { expect, test } from './coverage.ts';

const astroFile = '.tmp/e2e-site/src/pages/index.astro';
const canonicalAstroFile = 'demo/src/pages/index.astro';
const markdownFile = '.tmp/e2e-site/src/pages/article.md';

test('edits, selects, formats, links, and saves rich text', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/');
  const paragraph = page.locator('p.lead');
  await paragraph.click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await paragraph.press('Control+a');
  await paragraph.pressSequentially('Cross browser edit');
  await paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error('Missing paragraph text.');
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 13);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  const toolbar = page.locator('#astro-wysiwyg-toolbar').getByRole('toolbar', { name: 'Edit text' });
  await toolbar.getByRole('button', { name: 'Link' }).click();
  await toolbar.getByRole('textbox', { name: 'Link URL' }).fill('/docs');
  await toolbar.getByRole('button', { name: 'Apply link' }).click();
  await expect(paragraph.getByRole('link', { name: 'browser' })).toHaveAttribute('href', '/docs');

  await paragraph.press('Control+a');
  await paragraph.press('Control+b');
  await expect(paragraph.locator('b, strong')).toContainText('Cross browser edit');
  await toolbar.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => readFile(astroFile, 'utf8')).toContain(
    '<p class="lead"><b>Cross <a href="/docs">browser</a> edit</b></p>',
  );
  await expect.poll(async () => readFile(canonicalAstroFile, 'utf8')).not.toContain('Cross browser edit');
});

test('uses one roving stop for editable block focus', async ({ page }) => {
  await page.goto('/focus-order');
  const paragraphs = page.locator('main > p');
  await expect(page.locator('main > p[data-wysiwyg-added-tabindex][tabindex="0"]')).toHaveCount(1);
  await paragraphs.first().focus();
  await paragraphs.first().press('Alt+ArrowDown');
  await expect(paragraphs.nth(1)).toBeFocused();
  await expect(paragraphs.first()).toHaveAttribute('tabindex', '-1');
  await expect(paragraphs.nth(1)).toHaveAttribute('tabindex', '0');
});

test('opens, edits, and saves the frontmatter dialog', async ({ page }) => {
  await page.goto('/article');
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  const dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'title' }).fill('Cross-browser frontmatter');
  await dialog.getByRole('button', { name: 'Save frontmatter' }).click();
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('title: Cross-browser frontmatter');
});
