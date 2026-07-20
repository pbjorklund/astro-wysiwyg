import { expect, test } from './coverage.ts';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

const createdFile = '.tmp/e2e-site/src/content/articles/created-entry/index.md';

async function openCreateDialog(page: Page) {
  await page.getByRole('button', { name: 'Page editor' }).click();
  await page.getByRole('button', { name: 'Create entry' }).click();
  return page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Create collection entry' });
}

test('creates, opens, validates, and protects a local content collection entry', async ({ page }) => {
  await page.goto('/');
  let dialog = await openCreateDialog(page);
  await expect(dialog.getByRole('combobox', { name: 'Collection' })).toHaveValue('articles');
  await expect(dialog.getByText('generated:', { exact: false })).toContainText('local glob');
  await expect(dialog.getByRole('combobox', { name: 'Collection' })).toContainText('articles (src/content/articles, .md)');

  const slug = dialog.getByRole('textbox', { name: 'Slug or filename' });
  await slug.fill('Bad Slug');
  await dialog.getByRole('textbox', { name: 'title (required)' }).fill('Created article');
  await dialog.getByRole('textbox', { name: 'description (required)' }).fill('Created from the Page editor');
  await dialog.getByRole('textbox', { name: 'Starter body' }).fill('This entry was created from the canonical demo.');
  await dialog.getByRole('button', { name: 'Create entry' }).click();
  await expect(slug).toHaveJSProperty('validity.valid', false);
  await expect(dialog.getByText('Use lowercase letters, numbers, and single hyphens.')).toBeVisible();

  await slug.fill('created-entry');
  await dialog.getByRole('button', { name: 'Create entry' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(`Entry created at src/content/articles/created-entry/index.md.`);
  await expect.poll(async () => readFile(createdFile, 'utf8')).toContain('title: "Created article"');
  await expect(dialog.getByRole('link', { name: 'Open new entry' })).toBeHidden();
  await expect(dialog.getByText('Restart Astro so getStaticPaths includes the new entry')).toContainText('/articles/created-entry/');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/');
  dialog = await openCreateDialog(page);
  await dialog.getByRole('textbox', { name: 'Slug or filename' }).fill('created-entry');
  await dialog.getByRole('textbox', { name: 'title (required)' }).fill('Duplicate article');
  await dialog.getByRole('textbox', { name: 'description (required)' }).fill('Must not overwrite');
  await dialog.getByRole('button', { name: 'Create entry' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  expect(await readFile(createdFile, 'utf8')).not.toContain('Duplicate article');
});

test('handles collection field types, direct routes, empty discovery, cancellation, and request failures', async ({ page }) => {
  let discoveryMode: 'rich' | 'empty' | 'error' = 'rich';
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const request = route.request().postDataJSON();
    if (request.collections === 'discover') {
      if (discoveryMode === 'error') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      } else if (discoveryMode === 'empty') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ collections: [], unsupported: [] }) });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            collections: [
              {
                name: 'rich', directory: 'src/content/rich', extension: '.md', entryStyle: 'flat',
                fields: [
                  { name: 'title', type: 'string', required: true },
                  { name: 'featured', type: 'boolean', required: false, defaultValue: true },
                  { name: 'releaseDate', type: 'date', required: false, defaultValue: '2026-07-21' },
                  { name: 'score', type: 'number', required: false, defaultValue: '3' },
                  { name: 'tags', type: 'list', required: false, defaultValue: 'one, two' },
                ],
                omittedFields: [{ name: 'category', reason: 'Unsupported enum.' }],
              },
              {
                name: 'second', directory: 'src/content/second', extension: '.mdx', entryStyle: 'index',
                fields: [{ name: 'title', type: 'string', required: true }],
              },
            ],
            unsupported: [],
          }),
        });
      }
      return;
    }
    if (request.slug === 'direct-route') {
      await route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ created: true, file: 'src/content/rich/direct-route.md', route: '/rich/direct-route/' }),
      });
    } else if (request.slug === 'no-guidance') {
      await route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ created: true, file: 'src/content/rich/no-guidance.md' }),
      });
    } else {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    }
  });
  await page.goto('/');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const open = async () => {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('astro-wysiwyg:create-collection-entry')));
    return editor.getByRole('dialog', { name: 'Create collection entry' });
  };
  let dialog = await open();
  const collection = dialog.getByRole('combobox', { name: 'Collection' });
  await expect(collection).toHaveValue('rich');
  await expect(dialog.locator('[data-unsupported-collections]')).toBeHidden();
  await expect(dialog.getByRole('checkbox', { name: 'featured' })).toBeChecked();
  await expect(dialog.getByLabel('releaseDate')).toHaveValue('2026-07-21');
  await expect(dialog.getByRole('spinbutton', { name: 'score' })).toHaveValue('3');
  await expect(dialog.getByRole('textbox', { name: 'tags' })).toHaveValue('one, two');
  await expect(dialog.getByText('Optional fields not shown: category.')).toBeVisible();
  await collection.selectOption('second');
  await expect(dialog.getByRole('textbox', { name: 'title (required)' })).toBeVisible();
  await collection.selectOption('rich');

  await dialog.getByRole('textbox', { name: 'Slug or filename' }).fill('direct-route');
  await dialog.getByRole('textbox', { name: 'title (required)' }).fill('Direct route');
  await dialog.getByRole('button', { name: 'Create entry' }).click();
  const directRoute = dialog.getByRole('link', { name: 'Open new entry' });
  await expect(directRoute).toHaveAttribute('href', '/rich/direct-route/');
  await expect(directRoute).toBeFocused();
  await dialog.evaluate((element) => element.dispatchEvent(new Event('cancel', { cancelable: true })));
  await expect(dialog).not.toBeVisible();

  dialog = await open();
  await dialog.getByRole('textbox', { name: 'Slug or filename' }).fill('no-guidance');
  await dialog.getByRole('textbox', { name: 'title (required)' }).fill('No guidance');
  await dialog.getByRole('button', { name: 'Create entry' }).click();
  await expect(dialog.getByText('No matching src/pages/rich/[slug].astro route was found.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  dialog = await open();
  await dialog.getByRole('textbox', { name: 'Slug or filename' }).fill('request-failure');
  await dialog.getByRole('textbox', { name: 'title (required)' }).fill('Request failure');
  await dialog.getByRole('button', { name: 'Create entry' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The collection entry could not be created.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  discoveryMode = 'empty';
  dialog = await open();
  await expect(dialog.getByRole('alert')).toHaveText('No writable local collections were found. Review the unsupported collection details below.');
  await expect(dialog.getByRole('button', { name: 'Create entry' })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Collection' }).evaluate((select) => {
    const option = document.createElement('option');
    option.value = 'missing';
    option.textContent = 'Missing';
    select.append(option);
    (select as HTMLSelectElement).value = 'missing';
  });
  await dialog.getByRole('textbox', { name: 'Slug or filename' }).fill('missing');
  await dialog.getByRole('button', { name: 'Create entry' }).evaluate((button) => (
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
  ));
  await expect(dialog.getByRole('alert')).toHaveText('Choose a writable collection.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  discoveryMode = 'error';
  dialog = await open();
  await expect(dialog.getByRole('alert')).toHaveText('Writable collections could not be loaded.');
  await expect(dialog.getByRole('combobox', { name: 'Collection' }).locator('option')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
});
