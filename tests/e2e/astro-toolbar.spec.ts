import { expect, test } from './coverage.ts';

test('updates preferences and placement through the Astro dev toolbar', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', '{invalid');
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-astro-wysiwyg-enabled', '');
  await page.getByRole('button', { name: 'Page editor' }).click();
  const autosave = page.getByRole('checkbox', { name: 'Autosave changes' });
  await expect(autosave).toBeChecked();
  await page.evaluate(() => {
    (window as Window & { preferenceEvents?: unknown[] }).preferenceEvents = [];
    document.addEventListener('astro-wysiwyg:preferences', (event) => {
      (window as Window & { preferenceEvents: unknown[] }).preferenceEvents.push((event as CustomEvent).detail);
    });
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
  });
  await autosave.evaluate((element) => (element as HTMLInputElement).click());
  expect(await page.evaluate(() => (window as Window & { preferenceEvents: unknown[] }).preferenceEvents)).toEqual([
    { enabled: true, autosave: false, highlights: true },
  ]);

  await page.getByRole('button', { name: 'Settings' }).click();
  const placement = page.getByRole('combobox');
  await placement.selectOption('bottom-left');
  await page.getByRole('button', { name: 'Page editor' }).click();
  await expect(page.getByRole('heading', { name: 'Page editor' })).toBeVisible();
});
