import { expect, test } from './coverage.ts';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const astroFile = '.tmp/e2e-site/src/pages/index.astro';
const markdownFile = '.tmp/e2e-site/src/pages/article.md';
const mdxFile = '.tmp/e2e-site/src/pages/mdx.mdx';
const cardFile = '.tmp/e2e-site/src/content/articles/example/index.md';
const linkFile = '.tmp/e2e-site/src/pages/links.md';
const listFile = '.tmp/e2e-site/src/pages/lists.md';
const headingFile = '.tmp/e2e-site/src/pages/headings.md';
const queueFile = '.tmp/e2e-site/src/pages/resilience/queue.md';
const blocksFile = '.tmp/e2e-site/src/pages/blocks.md';
const imagesFile = '.tmp/e2e-site/src/pages/images.md';
const uploadedImageFile = '.tmp/e2e-site/public/assets/workflow.png';
const uploadedReplacementFile = '.tmp/e2e-site/public/assets/uploaded-replacement.png';
const videosFile = '.tmp/e2e-site/src/pages/videos.md';
const uploadedVideoFile = '.tmp/e2e-site/public/assets/walkthrough.mp4';

async function seedActiveSessionOnNextLoad(page: Page, patch: Record<string, unknown>): Promise<void> {
  const session = await page.evaluate(() => (
    JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}') as Record<string, unknown>
  ));
  Object.assign(session, patch);
  const serialized = JSON.stringify(session);
  await page.addInitScript((value) => {
    const seedKey = 'astro-wysiwyg-test-session-seeded';
    if (sessionStorage.getItem(seedKey)) return;
    sessionStorage.setItem(seedKey, 'true');
    sessionStorage.setItem('astro-wysiwyg-active', value);
  }, serialized);
}

test('edits an Astro block with keyboard formatting and saves to disk', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('wysiwyg-loads', String(Number(sessionStorage.getItem('wysiwyg-loads') ?? 0) + 1));
  });
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
  await expect(editorToolbar.getByRole('button', { name: 'Text style: Paragraph' })).toBeFocused();
  await paragraph.click();
  await paragraph.press('Control+a');
  await paragraph.pressSequentially('Saved from the browser');
  await paragraph.press('Control+a');
  await paragraph.press('Control+b');
  await expect(paragraph.locator('b, strong')).toHaveText('Saved from the browser');
  await expect(editorToolbar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');

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
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => sessionStorage.getItem('wysiwyg-loads'))).toBe('1');
});

test('edits MDX prose beside a component boundary', async ({ page }) => {
  await page.goto('/mdx');
  const paragraph = page.getByText('Edit this MDX paragraph and save it to the source file.', { exact: true });
  await expect(paragraph).toHaveAttribute('data-astro-wysiwyg', /.+/);
  await paragraph.click();
  await paragraph.press('Control+a');
  await paragraph.pressSequentially('Saved MDX paragraph.');

  await expect.poll(async () => readFile(mdxFile, 'utf8')).toContain('Saved MDX paragraph.');
  await expect(page.getByRole('complementary', { name: 'Component boundary' })).toContainText(
    'Component output stays separate from the editable MDX prose around it.',
  );
});

test('exposes every toolbar action without horizontal scrolling at narrow and zoom-equivalent viewports', async ({ page }) => {
  for (const width of [320, 400]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Demo pages' })).toBeVisible();
    const paragraph = page.locator('p.lead');
    await paragraph.click();
    const toolbar = page.locator('#astro-wysiwyg-toolbar').getByRole('toolbar', { name: 'Edit text' });
    await expect(toolbar).toBeVisible();
    const bounds = await toolbar.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);
    expect(bounds!.width).toBeLessThanOrEqual(width - 16);
    expect(await toolbar.evaluate((element) => getComputedStyle(element).overflowX)).not.toMatch(/auto|scroll/);
    const targets = await toolbar.locator('[data-toolbar-item]:not([hidden])').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
    }));
    for (const target of targets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.left).toBeGreaterThanOrEqual(8);
      expect(target.right).toBeLessThanOrEqual(width - 8);
    }
    for (const name of ['Text style: Paragraph', 'Insert']) {
      await toolbar.getByRole('button', { name }).click();
      const menu = toolbar.getByRole('menu', { name: name.startsWith('Text') ? 'Text style' : 'Insert' });
      const menuBounds = await menu.boundingBox();
      expect(menuBounds).not.toBeNull();
      expect(menuBounds!.x).toBeGreaterThanOrEqual(8);
      expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(width - 8);
      await page.keyboard.press('Escape');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await paragraph.press('Escape');
  }

  // A 320 CSS pixel layout is the reflow width of a 640 pixel viewport at 200% browser zoom.
});

test('keeps toolbar boundaries, state, and focus visible in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/keyboard');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.press('Alt+F10');
  const toolbar = page.locator('#astro-wysiwyg-toolbar').getByRole('toolbar', { name: 'Edit text' });
  const style = toolbar.getByRole('button', { name: 'Text style: Paragraph' });
  await expect(style).toBeFocused();
  const styles = await style.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { border: computed.borderStyle, outline: computed.outlineStyle, minWidth: computed.minWidth };
  });
  expect(styles.border).not.toBe('none');
  expect(styles.outline).not.toBe('none');
  expect(Number.parseFloat(styles.minWidth)).toBeGreaterThanOrEqual(44);
  await style.click();
  await expect(style).toHaveAttribute('aria-expanded', 'true');
  expect(await style.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
});

test('edits a rendered frontmatter title without leaving edit mode', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('wysiwyg-loads', String(Number(sessionStorage.getItem('wysiwyg-loads') ?? 0) + 1));
  });
  await page.goto('/article');
  const title = page.locator('h1.frontmatter-title');
  await title.click();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await expect(editor.getByRole('button', { name: 'Insert' })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Delete block' })).toBeDisabled();
  await title.press('End');
  await title.pressSequentially(' updated');

  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('title: Markdown editing updated');
  await page.waitForTimeout(2_000);
  await expect(title).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('wysiwyg-loads'))).toBe('1');

  await page.reload();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('wysiwyg-loads'))).toBe('2');
  await editor.locator('[data-action="add-block"]').evaluate((button) => {
    (button as HTMLButtonElement).disabled = false;
    (button as HTMLButtonElement).click();
  });
  await expect(editor.getByRole('status')).toHaveText('Frontmatter fields cannot be added or deleted.');
});

test('edits article frontmatter from the Astro dev-toolbar app without selecting content', async ({ page }) => {
  await page.goto('/article');
  const formattingToolbar = page.locator('#astro-wysiwyg-toolbar');
  await expect(formattingToolbar.getByRole('button', { name: 'Frontmatter' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Page editor' }).click();
  await page.getByRole('button', { name: 'Edit frontmatter' }).click();
  const dialog = formattingToolbar.getByRole('dialog', { name: 'Edit frontmatter' });
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

test('keeps the frontmatter panel open when a submitted field changed on disk', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.frontmatter !== 'update') return route.continue();
    submitted = body;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'The title frontmatter field changed on disk. Close and reopen the frontmatter editor before saving again.',
      }),
    });
  });
  await page.goto('/article');
  await page.getByRole('button', { name: 'Page editor' }).click();
  await page.getByRole('button', { name: 'Edit frontmatter' }).click();
  const dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await dialog.getByRole('textbox', { name: 'title' }).fill('Editor title');
  await dialog.getByRole('button', { name: 'Save frontmatter' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText(
    'The title frontmatter field changed on disk. Close and reopen the frontmatter editor before saving again.',
  );
  expect(submitted).toEqual({
    frontmatter: 'update',
    contextMarker: expect.any(String),
    changes: { title: { value: 'Editor title', original: 'Markdown editing' } },
  });
});

test('restores unsaved frontmatter after navigation and reload until it is saved', async ({ page }) => {
  let submittedChanges: Record<string, { original: string; value: string | boolean }> | undefined;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const body = route.request().postDataJSON() as {
      frontmatter?: string;
      changes?: Record<string, { original: string; value: string | boolean }>;
    };
    if (body.frontmatter === 'update') submittedChanges = body.changes;
    await route.continue();
  });
  await page.goto('/article');
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  let dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await dialog.getByRole('textbox', { name: 'title' }).fill('Recovered frontmatter');
  await dialog.getByRole('textbox', { name: 'tags' }).fill('draft, recovered');
  await dialog.getByRole('checkbox', { name: 'aiDisclaimer' }).check();

  await page.goto('/');
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' })).not.toBeVisible();
  await page.goto('/article');
  dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText('Restored unsaved frontmatter changes.');
  await expect(dialog.getByRole('textbox', { name: 'title' })).toHaveValue('Recovered frontmatter');
  await expect(dialog.getByRole('textbox', { name: 'tags' })).toHaveValue('draft, recovered');
  await expect(dialog.getByRole('checkbox', { name: 'aiDisclaimer' })).toBeChecked();

  await page.reload();
  dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'title' })).toHaveValue('Recovered frontmatter');
  await dialog.getByRole('button', { name: 'Save frontmatter' }).click();
  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('title: Recovered frontmatter');
  expect(submittedChanges).toEqual({
    title: { value: 'Recovered frontmatter', original: 'Markdown editing' },
    tags: { value: 'draft, recovered', original: '["astro", "markdown"]' },
    aiDisclaimer: { value: true, original: 'false' },
  });

  await page.reload();
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' })).not.toBeVisible();
});

test('discards frontmatter drafts on cancel and tolerates unavailable session storage', async ({ page }) => {
  await page.goto('/article');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  let dialog = editor.getByRole('dialog', { name: 'Edit frontmatter' });
  const title = dialog.getByRole('textbox', { name: 'title' });
  await title.fill('Discard this draft');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('astro-wysiwyg-frontmatter-draft')))
    .not.toBeNull();
  await title.fill('Markdown editing');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('astro-wysiwyg-frontmatter-draft')))
    .toBeNull();
  await title.fill('Discard this draft');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await expect(editor.getByRole('dialog', { name: 'Edit frontmatter' })).not.toBeVisible();

  for (const stored of [
    '{',
    '1',
    JSON.stringify({ pathname: '/other', contextMarker: 'marker', changes: {} }),
    JSON.stringify({ pathname: '/article' }),
    JSON.stringify({ pathname: '/article', contextMarker: 'marker' }),
    JSON.stringify({ pathname: '/article', contextMarker: 'marker', changes: [] }),
    JSON.stringify({ pathname: '/article', contextMarker: 'marker', changes: { title: null } }),
    JSON.stringify({ pathname: '/article', contextMarker: 'marker', changes: { title: [] } }),
    JSON.stringify({ pathname: '/article', contextMarker: 'marker', changes: { title: { original: 1, value: 'x' } } }),
    JSON.stringify({ pathname: '/article', contextMarker: 'marker', changes: { title: { original: 'old', value: 1 } } }),
  ]) {
    await page.evaluate((value) => {
      sessionStorage.setItem('astro-wysiwyg-frontmatter-draft', value);
    }, stored);
    await page.reload();
    await expect(editor.getByRole('dialog', { name: 'Edit frontmatter' })).not.toBeVisible();
  }

  const contextMarker = await page.locator('[data-astro-wysiwyg]').first().getAttribute('data-astro-wysiwyg');
  await page.evaluate(({ marker }) => {
    sessionStorage.setItem('astro-wysiwyg-frontmatter-draft', JSON.stringify({
      pathname: '/article',
      contextMarker: marker,
      changes: { title: { original: 'Markdown editing', value: true } },
    }));
  }, { marker: contextMarker });
  await page.reload();
  dialog = editor.getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog.getByRole('alert')).toHaveText('The unsaved frontmatter fields are no longer available.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  dialog = editor.getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
  });
  await dialog.getByRole('textbox', { name: 'title' }).fill('Unsaved without storage');
  await expect(dialog.getByRole('textbox', { name: 'title' })).toHaveValue('Unsaved without storage');
  await page.evaluate(() => {
    Storage.prototype.removeItem = () => { throw new Error('Storage unavailable'); };
  });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
});

test('keeps layout, focus, selection, scroll, and session stable through manual save and autosave', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/keyboard');
  await page.evaluate(() => {
    document.body.style.minHeight = '2400px';
    scrollTo(0, 320);
  });
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.evaluate((element) => {
    element.dataset.saveStabilityIdentity = 'original';
    document.querySelector<HTMLElement>('header')!.dataset.saveStabilityIdentity = 'original';
    element.textContent = 'Stable selection through repeated saves.';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 16);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents = [];
    document.addEventListener('astro:before-swap', () => {
      (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents?.push('before-swap');
    });
    document.addEventListener('astro:page-load', () => {
      (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents?.push('page-load');
    });
  });
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const status = editor.getByRole('status');
  await expect(status).toHaveText('Unsaved');

  const snapshot = () => page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('main > p')!;
    const toolbar = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot
      ?.querySelector<HTMLElement>('[role="toolbar"]')!;
    const selection = getSelection();
    const blockRect = block.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const session = JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}') as {
      html?: string;
      pathname?: string;
      tag?: string;
    };
    return {
      blockIdentity: block.dataset.saveStabilityIdentity,
      shellIdentity: document.querySelector<HTMLElement>('header')?.dataset.saveStabilityIdentity,
      blockRect: [blockRect.x, blockRect.y, blockRect.width, blockRect.height],
      toolbarRect: [toolbarRect.x, toolbarRect.y, toolbarRect.width, toolbarRect.height],
      focused: document.activeElement === block,
      selection: selection ? [selection.anchorOffset, selection.focusOffset, selection.toString()] : [],
      scroll: [scrollX, scrollY],
      session: { html: session.html, pathname: session.pathname, tag: session.tag },
      events: (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents ?? [],
    };
  });
  const before = await snapshot();
  const save = editor.getByRole('button', { name: 'Save' });
  await save.click();
  await expect(status).toHaveText('Saving...');
  await save.click();
  await expect.poll(async () => readFile('.tmp/e2e-site/src/pages/keyboard.md', 'utf8'))
    .toContain('Stable selection through repeated saves.');
  await expect(status).toHaveText('Saved');
  await page.waitForTimeout(1_000);

  expect(await snapshot()).toEqual(before);
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: true, autosave: true, highlights: true },
    }));
  });
  await paragraph.evaluate((element) => {
    const saveStatuses: string[] = [];
    const status = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot
      ?.querySelector<HTMLElement>('[role="status"]')!;
    new MutationObserver(() => saveStatuses.push(status.textContent ?? '')).observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    (window as Window & { __saveStatuses?: string[] }).__saveStatuses = saveStatuses;
    element.textContent = 'Stable selection through autosave.';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    const text = element.firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 16);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents = [];
  });
  await expect(status).toHaveText('Unsaved');
  const beforeAutosave = await snapshot();
  await expect(status).toHaveText('Saved');
  await expect.poll(async () => readFile('.tmp/e2e-site/src/pages/keyboard.md', 'utf8'))
    .toContain('Stable selection through autosave.');
  await page.waitForTimeout(1_000);

  expect(await page.evaluate(() => {
    const statuses = (window as Window & { __saveStatuses?: string[] }).__saveStatuses ?? [];
    return statuses.filter((value, index) => index === 0 || value !== statuses[index - 1]);
  })).toEqual(['Unsaved', 'Saving...', 'Saved']);
  expect(await snapshot()).toEqual(beforeAutosave);
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
});

test('keeps a rendered content-collection edit stable through save', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/cards');
  const title = page.locator('h2.card-title');
  await title.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await expect(editor.getByRole('toolbar', { name: 'Edit text' })).toBeVisible();
  await title.evaluate((element) => {
    element.dataset.saveStabilityIdentity = 'original';
    element.textContent = 'Stable rendered card title';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents = [];
    document.addEventListener('astro:before-swap', () => {
      (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents?.push('before-swap');
    });
    document.addEventListener('astro:page-load', () => {
      (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents?.push('page-load');
    });
  });
  const before = await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('h2.card-title')!;
    const toolbar = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot
      ?.querySelector<HTMLElement>('[role="toolbar"]')!;
    const blockRect = block.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    return {
      block: [blockRect.x, blockRect.y, blockRect.width, blockRect.height],
      toolbar: [toolbarRect.x, toolbarRect.y, toolbarRect.width, toolbarRect.height],
      scroll: [scrollX, scrollY],
    };
  });

  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved');
  await expect.poll(async () => readFile(cardFile, 'utf8')).toContain('title: "Stable rendered card title"');
  await page.waitForTimeout(2_500);

  await expect(title).toHaveAttribute('data-save-stability-identity', 'original');
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await expect(title).toBeFocused();
  expect(await title.evaluate((element) => getSelection()?.toString())).toBe('Stable rendered card title');
  expect(await page.evaluate(() => (
    (window as Window & { __saveStabilityEvents?: string[] }).__saveStabilityEvents ?? []
  ))).toEqual([]);
  expect(await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('h2.card-title')!;
    const toolbar = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot
      ?.querySelector<HTMLElement>('[role="toolbar"]')!;
    const blockRect = block.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    return {
      block: [blockRect.x, blockRect.y, blockRect.width, blockRect.height],
      toolbar: [toolbarRect.x, toolbarRect.y, toolbarRect.width, toolbarRect.height],
      scroll: [scrollX, scrollY],
    };
  })).toEqual(before);
});

test('allows a genuine external content change to reload after an editor save', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
    const key = 'astro-wysiwyg-external-reloads';
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? 0) + 1));
  });
  await page.goto('/cards');
  const title = page.locator('h2.card-title');
  await title.click();
  await title.evaluate((element) => {
    element.textContent = 'Editor save before external change';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved');
  await expect.poll(async () => readFile(cardFile, 'utf8')).toContain('title: "Editor save before external change"');
  const loadsBeforeExternalWrite = Number(await page.evaluate(() => (
    sessionStorage.getItem('astro-wysiwyg-external-reloads')
  )));
  await page.waitForTimeout(300);

  const editorSource = await readFile(cardFile, 'utf8');
  await writeFile(cardFile, editorSource.replace(
    'title: "Editor save before external change"',
    'title: "External content change"',
  ));

  await expect.poll(async () => Number(await page.evaluate(() => (
    sessionStorage.getItem('astro-wysiwyg-external-reloads')
  )))).toBeGreaterThan(loadsBeforeExternalWrite);
  await expect.poll(async () => {
    const token = await title.getAttribute('data-astro-wysiwyg');
    if (!token) return '';
    return (JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { original?: string }).original ?? '';
  }).toContain('External content change');
});

test('uploads, inserts, renders, selects, and removes a source-backed image', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/images');
  const target = page.getByText('Select this paragraph, then use', { exact: false });
  await target.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Link' }).click();
  const linkDialog = editor.getByRole('dialog', { name: 'Edit link' });
  await expect(linkDialog).toBeVisible();
  await editor.getByRole('button', { name: 'Insert', exact: true }).click();
  await editor.getByRole('menuitem', { name: 'Image' }).click();
  const dialog = editor.getByRole('dialog', { name: 'Insert image' });
  await expect(dialog).toBeVisible();
  await expect(linkDialog).not.toBeVisible();
  await dialog.getByLabel('Image file', { exact: true }).setInputFiles({
    name: 'Project Diagram.PNG',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });
  await expect(dialog.getByLabel('Destination name')).toHaveValue('project-diagram.png');
  await dialog.getByLabel('Destination name').fill('workflow.png');
  await dialog.getByLabel('Alt text').fill('Project workflow diagram');
  await dialog.getByRole('button', { name: 'Upload image' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Uploaded to /assets/workflow.png');
  await expect(dialog.getByRole('button', { name: 'Upload image' })).toBeDisabled();
  await expect(dialog.getByLabel('Image file', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Destination name')).toBeDisabled();
  await expect.poll(async () => (await readFile(uploadedImageFile)).subarray(0, 8).toString('hex'))
    .toBe('89504e470d0a1a0a');

  await dialog.getByRole('button', { name: 'Insert image' }).click();
  await expect(dialog).not.toBeVisible();
  let image = page.getByRole('img', { name: 'Project workflow diagram' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect.poll(async () => readFile(imagesFile, 'utf8'))
    .toContain('![Project workflow diagram](/assets/workflow.png)');

  await page.reload();
  image = page.getByRole('img', { name: 'Project workflow diagram' });
  await expect(image).toBeVisible();
  const imageBlock = image.locator('..');
  await expect(imageBlock).toHaveAttribute('data-astro-wysiwyg', /.+/);
  await image.click();
  await expect(imageBlock).toHaveAttribute('contenteditable', 'true');
  page.once('dialog', (confirmation) => confirmation.accept());
  await editor.getByRole('button', { name: 'Delete block' }).click();
  await expect(image).toHaveCount(0);
  await expect.poll(async () => readFile(imagesFile, 'utf8'))
    .not.toContain('![Project workflow diagram](/assets/workflow.png)');
  await expect.poll(async () => readFile(uploadedImageFile).then(() => true)).toBe(true);
});

test('previews, cancels, rejects, and applies in-place image replacements', async ({ page }) => {
  const originalSource = await readFile(imagesFile, 'utf8');
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/images');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  let image = page.getByRole('img', { name: 'Original replaceable example' });
  await image.click();
  const replace = editor.getByRole('button', { name: 'Replace image', exact: true });
  await expect(replace).toBeVisible();
  await replace.click();
  let dialog = editor.getByRole('dialog', { name: 'Replace image' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Alt text')).toHaveValue('Original replaceable example');
  await expect(dialog.getByRole('img', { name: 'Replacement preview' })).toBeVisible();
  await dialog.getByLabel('Existing project asset').check();
  await expect(dialog.getByLabel('Project asset reference')).toBeFocused();
  await dialog.getByLabel('Upload new image').check();
  await expect(dialog.getByLabel('Image file', { exact: true })).toBeFocused();
  await dialog.getByLabel('Existing project asset').check();
  await dialog.getByLabel('Project asset reference').fill('/assets/replace-alternate.png');
  await expect(dialog.getByRole('button', { name: 'Replace image' })).toBeEnabled();
  const preview = dialog.getByRole('img', { name: 'Replacement preview' });
  await expect(preview).toHaveAttribute('src', /assets\/preview\?.*replace-alternate\.png/);
  await expect.poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await dialog.getByLabel('Alt text').fill('Cancelled replacement');
  await dialog.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(replace).toBeFocused();
  expect(await readFile(imagesFile, 'utf8')).toBe(originalSource);

  await replace.click();
  dialog = editor.getByRole('dialog', { name: 'Replace image' });
  await dialog.getByLabel('Existing project asset').check();
  await dialog.getByLabel('Project asset reference').fill('/assets/missing.png');
  await dialog.getByLabel('Alt text').fill('Rejected replacement');
  await dialog.getByRole('button', { name: 'Replace image' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The selected project image does not exist.');
  expect(await readFile(imagesFile, 'utf8')).toBe(originalSource);

  await dialog.getByLabel('Project asset reference').fill('/assets/replace-alternate.png');
  await dialog.getByLabel('Alt text').fill('Alternate replaceable example');
  await dialog.getByRole('button', { name: 'Replace image' }).click();
  await expect(dialog).not.toBeVisible();
  image = page.getByRole('img', { name: 'Alternate replaceable example' });
  await expect(image).toBeVisible();
  await expect(image.locator('..')).toHaveAttribute('href', '/images');
  await expect(image.locator('xpath=../..')).toContainText('This linked caption stays in place.');
  await expect.poll(async () => readFile(imagesFile, 'utf8')).toContain(
    '[![Alternate replaceable example](/assets/replace-alternate.png "Replaceable demo image")](/images) This linked caption stays in place.',
  );

  await image.click();
  await replace.click();
  dialog = editor.getByRole('dialog', { name: 'Replace image' });
  await dialog.getByLabel('Image file', { exact: true }).setInputFiles({
    name: 'Uploaded replacement.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });
  await dialog.getByLabel('Destination name').fill('uploaded-replacement.png');
  await dialog.getByLabel('Alt text').fill('Uploaded replaceable example');
  await dialog.getByRole('button', { name: 'Upload image' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Uploaded to /assets/uploaded-replacement.png');
  const sourceBeforeConflict = await readFile(imagesFile, 'utf8');
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The source changed before image replacement.' }),
    });
  });
  await dialog.getByRole('button', { name: 'Replace image' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The source changed before image replacement.');
  await expect(dialog).toBeVisible();
  expect(await readFile(imagesFile, 'utf8')).toBe(sourceBeforeConflict);
  await expect.poll(async () => readFile(uploadedReplacementFile).then(() => true)).toBe(true);
  await page.unroute('**/_astro-wysiwyg/save');
  await dialog.getByRole('button', { name: 'Replace image' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('img', { name: 'Uploaded replaceable example' })).toBeVisible();
  await expect.poll(async () => readFile(imagesFile, 'utf8')).toContain(
    '[![Uploaded replaceable example](/assets/uploaded-replacement.png "Replaceable demo image")](/images) This linked caption stays in place.',
  );
  await expect.poll(async () => readFile('.tmp/e2e-site/public/assets/replace-original.png').then(() => true))
    .toBe(true);

  await page.reload();
  await expect(page.getByRole('img', { name: 'Uploaded replaceable example' })).toBeVisible();
  await expect(page.getByText('This linked caption stays in place.')).toBeVisible();

  const sourceImage = page.getByRole('img', { name: 'Original source asset example' });
  await sourceImage.click();
  await editor.getByRole('button', { name: 'Replace image', exact: true }).click();
  dialog = editor.getByRole('dialog', { name: 'Replace image' });
  await dialog.getByLabel('Existing project asset').check();
  await dialog.getByLabel('Project asset reference').fill('../assets/replace-source-alternate.png');
  await dialog.getByLabel('Alt text').fill('Alternate source asset example');
  await dialog.getByRole('button', { name: 'Replace image' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('img', { name: 'Alternate source asset example' })).toBeVisible();
  await expect.poll(async () => readFile(imagesFile, 'utf8')).toContain(
    '![Alternate source asset example](../assets/replace-source-alternate.png)',
  );
  await page.reload();
  await expect(page.getByRole('img', { name: 'Alternate source asset example' })).toBeVisible();
  await writeFile(imagesFile, originalSource);

  await page.goto('/image-astro');
  for (const name of ['Astro imported image example', 'Astro public image example']) {
    const imageTarget = page.getByRole('img', { name });
    const target = imageTarget.locator('xpath=ancestor::p[1]');
    await imageTarget.click();
    await expect(target).toHaveAttribute('data-astro-wysiwyg', /.+/);
    await expect(editor.getByRole('button', { name: 'Replace image', exact: true })).toBeVisible();
  }
  await page.goto('/image-mdx');
  await expect(page.getByRole('img', { name: 'MDX replaceable image example' }).locator('xpath=ancestor::p[1]'))
    .toHaveAttribute('data-astro-wysiwyg', /.+/);
});

test('uploads and inserts an accessible native video with selected playback options', async ({ page }) => {
  const originalSource = await readFile(videosFile, 'utf8');
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/videos');
  const target = page.getByText('Select this paragraph, then use', { exact: false });
  await target.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Insert', exact: true }).click();
  await editor.getByRole('menuitem', { name: 'Video' }).click();
  const dialog = editor.getByRole('dialog', { name: 'Insert video' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Video file', { exact: true }).setInputFiles({
    name: 'Product Walkthrough.MP4',
    mimeType: 'video/mp4',
    buffer: await readFile('demo/public/assets/astro-wysiwyg-demo.mp4'),
  });
  await expect(dialog.getByLabel('Destination name')).toHaveValue('product-walkthrough.mp4');
  await dialog.getByLabel('Destination name').fill('walkthrough.mp4');
  await dialog.getByLabel('Accessible label').fill('Product walkthrough video');
  await dialog.getByLabel('Visible description').fill('A silent tour of the project dashboard.');
  await dialog.getByLabel('Poster image path (optional)').fill('/assets/astro-wysiwyg-video-poster.png');
  await dialog.getByLabel('Preload').selectOption('auto');
  await dialog.getByLabel('Controls', { exact: true }).uncheck();
  await expect.poll(() => dialog.getByLabel('Controls', { exact: true }).evaluate((input) => (
    (input as HTMLInputElement).validationMessage
  ))).toBe('Native video controls are required.');
  await dialog.getByLabel('Controls', { exact: true }).check();
  await dialog.getByLabel('Autoplay').check();
  await expect.poll(() => dialog.getByLabel('Autoplay').evaluate((input) => (
    (input as HTMLInputElement).validationMessage
  ))).toBe('Autoplay requires muted playback.');
  await dialog.getByLabel('Muted').check();
  await dialog.getByLabel('Loop').check();
  await expect(dialog.locator('[data-video-preview]')).toBeVisible();
  await expect.poll(() => dialog.locator('[data-video-preview]').evaluate((video) => (
    (video as HTMLVideoElement).videoWidth
  ))).toBeGreaterThan(0);

  await dialog.getByRole('button', { name: 'Upload video' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Uploaded to /assets/walkthrough.mp4');
  await expect(dialog.getByLabel('Video file', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Destination name')).toBeDisabled();
  await expect.poll(async () => readFile(uploadedVideoFile).then((value) => value.length)).toBeGreaterThan(0);

  await dialog.getByRole('button', { name: 'Insert video' }).click();
  await expect(dialog).not.toBeVisible();
  const video = page.locator('video[aria-label="Product walkthrough video"]');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('preload', 'auto');
  await expect(video).toHaveAttribute('poster', '/assets/astro-wysiwyg-video-poster.png');
  await expect(video).toHaveAttribute('muted', '');
  await expect(video).toHaveAttribute('loop', '');
  await expect(video).toHaveAttribute('autoplay', '');
  await expect(video.locator('source')).toHaveAttribute('src', '/assets/walkthrough.mp4');
  await expect(video.locator('xpath=..').getByText('A silent tour of the project dashboard.')).toBeVisible();
  await expect.poll(async () => readFile(videosFile, 'utf8')).toContain(
    '<video controls preload="auto" aria-label="Product walkthrough video" poster="/assets/astro-wysiwyg-video-poster.png" muted loop autoplay playsinline>',
  );

  await page.reload();
  await expect(page.locator('video[aria-label="Product walkthrough video"]')).toBeVisible();
  await writeFile(videosFile, originalSource);
});

test('cancels invalid video uploads and keeps an uploaded video after insertion failure', async ({ page }) => {
  const source = await readFile(videosFile, 'utf8');
  await page.goto('/videos');
  const target = page.getByText('Select this paragraph, then use', { exact: false });
  await target.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const openDialog = async () => {
    await editor.getByRole('button', { name: 'Insert', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Video' }).click();
    return editor.getByRole('dialog', { name: 'Insert video' });
  };

  let dialog = await openDialog();
  await dialog.getByRole('button', { name: 'Upload video' }).click();
  await dialog.press('Escape');
  await expect(dialog).not.toBeVisible();
  dialog = await openDialog();
  await dialog.getByLabel('Video file', { exact: true }).setInputFiles({
    name: 'cancelled.mp4', mimeType: 'video/mp4', buffer: Buffer.from('cancelled'),
  });
  await dialog.getByLabel('Accessible label').fill('Cancelled video');
  await dialog.getByLabel('Visible description').fill('This video should not be uploaded.');
  await dialog.evaluate((element) => element.dispatchEvent(new Event('cancel', { cancelable: true })));
  await expect(dialog).not.toBeVisible();
  await expect(editor.getByRole('button', { name: 'Insert', exact: true })).toBeFocused();
  await assertFileMissing('.tmp/e2e-site/public/assets/cancelled.mp4');

  dialog = await openDialog();
  await page.getByText('The editor requires native controls', { exact: false })
    .evaluate((element) => (element as HTMLElement).click());
  await expect(dialog).not.toBeVisible();
  await target.click();
  dialog = await openDialog();
  await editor.getByRole('button', { name: 'Done' }).evaluate((element) => (element as HTMLElement).click());
  await expect(dialog).not.toBeVisible();
  await target.click();

  dialog = await openDialog();
  await dialog.getByLabel('Video file', { exact: true }).setInputFiles({
    name: 'invalid.mp4', mimeType: 'video/mp4', buffer: Buffer.from('<video>not mp4</video>'),
  });
  await dialog.getByLabel('Accessible label').fill('Invalid video');
  await dialog.getByLabel('Visible description').fill('This invalid file must be rejected.');
  await dialog.getByRole('button', { name: 'Upload video' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The file is not a valid MP4 container.');
  await assertFileMissing('.tmp/e2e-site/public/assets/invalid.mp4');
  await dialog.getByLabel('Video file', { exact: true }).setInputFiles([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  dialog = await openDialog();
  await page.evaluate(() => {
    (window as typeof window & { originalCreateObjectURL?: typeof URL.createObjectURL }).originalCreateObjectURL = URL.createObjectURL;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: undefined });
  });
  await dialog.getByLabel('Video file', { exact: true }).evaluate((input, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'fallback-type.mp4', { type: '' }));
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [...await readFile('demo/public/assets/astro-wysiwyg-demo.mp4')]);
  await dialog.getByLabel('Accessible label').fill('Fallback type video');
  await dialog.getByLabel('Visible description').fill('This upload uses the browser content type fallback.');
  await dialog.getByRole('button', { name: 'Upload video' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Choose an H.264 MP4 video.');
  await page.evaluate(() => {
    const scope = window as typeof window & { originalCreateObjectURL?: typeof URL.createObjectURL };
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: scope.originalCreateObjectURL });
    delete scope.originalCreateObjectURL;
  });
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  dialog = await openDialog();
  await page.route('**/_astro-wysiwyg/save/videos', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await dialog.getByLabel('Video file', { exact: true }).setInputFiles({
    name: 'recoverable-video.mp4',
    mimeType: 'video/mp4',
    buffer: await readFile('demo/public/assets/astro-wysiwyg-demo.mp4'),
  });
  await dialog.getByLabel('Accessible label').fill('Recoverable video');
  await dialog.getByLabel('Visible description').fill('This upload remains available after insertion fails.');
  await dialog.getByRole('button', { name: 'Upload video' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The video could not be uploaded.');
  await page.unroute('**/_astro-wysiwyg/save/videos');
  await dialog.getByLabel('Accessible label').fill('Recoverable video');
  await dialog.getByLabel('Visible description').fill('This upload remains available after insertion fails.');
  await dialog.getByRole('button', { name: 'Upload video' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Uploaded to /assets/recoverable-video.mp4');
  await dialog.getByLabel('Accessible label').fill('');
  await dialog.getByRole('button', { name: 'Insert video' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Accessible label').fill('Recoverable video');
  const marker = await target.getAttribute('data-astro-wysiwyg');
  await target.evaluate((element) => element.removeAttribute('data-astro-wysiwyg'));
  await dialog.getByRole('button', { name: 'Insert video' }).click();
  await expect(editor.getByRole('status')).toHaveText('Frontmatter fields cannot be added or deleted.');
  await target.evaluate((element, value) => element.setAttribute('data-astro-wysiwyg', value!), marker);
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await dialog.getByRole('button', { name: 'Insert video' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The video could not be inserted.');
  await page.unroute('**/_astro-wysiwyg/save');
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The source changed before video insertion.' }),
    });
  });
  const insert = dialog.getByRole('button', { name: 'Insert video' });
  await insert.click();
  await expect(dialog.getByRole('alert')).toHaveText('The source changed before video insertion.');
  await expect(dialog).toBeVisible();
  await expect.poll(async () => readFile('.tmp/e2e-site/public/assets/recoverable-video.mp4').then(() => true))
    .toBe(true);
  expect(await readFile(videosFile, 'utf8')).toBe(source);
  await page.unroute('**/_astro-wysiwyg/save');

  let releaseInsertion!: () => void;
  let markInsertionStarted!: () => void;
  const insertionGate = new Promise<void>((resolve) => { releaseInsertion = resolve; });
  const insertionStarted = new Promise<void>((resolve) => { markInsertionStarted = resolve; });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    markInsertionStarted();
    await insertionGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ marker: 'detached-video-marker' }),
    });
  });
  await dialog.getByRole('button', { name: 'Insert video' }).click();
  await insertionStarted;
  await target.evaluate((element) => element.remove());
  releaseInsertion();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('video[aria-label="Recoverable video"]')).toHaveCount(0);
  await page.unroute('**/_astro-wysiwyg/save');
});

test('cancels image insertion and reports a disguised upload without changing files', async ({ page }) => {
  const source = await readFile(imagesFile, 'utf8');
  await page.goto('/images');
  const target = page.getByText('Select this paragraph, then use', { exact: false });
  await target.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const openDialog = async () => {
    await editor.getByRole('button', { name: 'Insert', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Image' }).click();
    return editor.getByRole('dialog', { name: 'Insert image' });
  };

  let dialog = await openDialog();
  await dialog.getByLabel('Image file', { exact: true }).setInputFiles({
    name: 'cancelled.png', mimeType: 'image/png', buffer: Buffer.from('not uploaded'),
  });
  await dialog.getByLabel('Alt text').fill('Cancelled image');
  await dialog.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(editor.getByRole('button', { name: 'Insert', exact: true })).toBeFocused();
  await assertFileMissing('.tmp/e2e-site/public/assets/cancelled.png');

  dialog = await openDialog();
  await dialog.evaluate((element) => element.dispatchEvent(new Event('cancel', { cancelable: true })));
  await expect(dialog).not.toBeVisible();
  await expect(editor.getByRole('button', { name: 'Insert', exact: true })).toBeFocused();

  dialog = await openDialog();
  await editor.getByRole('button', { name: 'Done' }).evaluate((button) => (button as HTMLButtonElement).click());
  await expect(dialog).not.toBeVisible();
  await target.click();

  dialog = await openDialog();
  await page.getByText('A successful insertion stays source-backed', { exact: false })
    .evaluate((element) => (element as HTMLElement).click());
  await expect(dialog).not.toBeVisible();

  dialog = await openDialog();
  await dialog.getByLabel('Image file', { exact: true }).evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['untyped'], 'untyped.png', { type: '' }));
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await dialog.getByLabel('Alt text').fill('Untyped image');
  await dialog.getByRole('button', { name: 'Upload image' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Choose a supported PNG, JPEG, GIF, or WebP image.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  dialog = await openDialog();
  await dialog.getByLabel('Image file', { exact: true }).setInputFiles({
    name: 'disguised.png', mimeType: 'image/png', buffer: Buffer.from('<svg><script>alert(1)</script></svg>'),
  });
  await dialog.getByLabel('Alt text').fill('Disguised image');
  await dialog.getByRole('button', { name: 'Upload image' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The file contents do not match the selected image type.');
  await expect(dialog).toBeVisible();
  await assertFileMissing('.tmp/e2e-site/public/assets/disguised.png');
  expect(await readFile(imagesFile, 'utf8')).toBe(source);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();

  dialog = await openDialog();
  await dialog.getByLabel('Image file', { exact: true }).setInputFiles({
    name: 'recoverable.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  });
  await dialog.getByLabel('Alt text').fill('Recoverable image');
  await dialog.getByRole('button', { name: 'Upload image' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Uploaded to /assets/recoverable.png');
  let releaseInsertion!: () => void;
  const insertionGate = new Promise<void>((resolve) => { releaseInsertion = resolve; });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await insertionGate;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The source changed before image insertion.' }),
    });
  });
  const insertImage = dialog.getByRole('button', { name: 'Insert image' });
  await insertImage.click();
  await expect(insertImage).toBeDisabled();
  await expect(insertImage).toHaveAttribute('aria-busy', 'true');
  releaseInsertion();
  await expect(dialog.getByRole('alert')).toHaveText('The source changed before image insertion.');
  await expect(insertImage).toBeEnabled();
  await expect(insertImage).toHaveAttribute('aria-busy', 'false');
  await expect(dialog).toBeVisible();
  expect(await readFile(imagesFile, 'utf8')).toBe(source);
  await expect.poll(async () => readFile('.tmp/e2e-site/public/assets/recoverable.png').then(() => true)).toBe(true);
  await page.unroute('**/_astro-wysiwyg/save');
  await page.locator('[data-astro-wysiwyg-active]').evaluate((element) => {
    element.removeAttribute('data-astro-wysiwyg');
  });
  await dialog.getByRole('button', { name: 'Insert image' }).click();
  await expect(editor.getByRole('status')).toHaveText('Frontmatter fields cannot be added or deleted.');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

async function assertFileMissing(file: string): Promise<void> {
  await expect.poll(async () => readFile(file).then(() => false).catch(() => true)).toBe(true);
}

test('queues continued Markdown edits behind an in-flight save', async ({ page }) => {
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    saveRequests += 1;
    if (saveRequests === 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await page.goto('/resilience/queue');
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

  await expect.poll(async () => readFile(queueFile, 'utf8')).toContain('Markdown **saved**');
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
});

test('coalesces queued snapshots to the latest edit while a save is in flight', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/queue');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  let releaseResponse: () => void = () => undefined;
  let requestStarted: () => void = () => undefined;
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const requests: Array<{ html: string; marker: string }> = [];
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const request = route.request().postDataJSON() as { html: string; marker: string };
    requests.push(request);
    if (requests.length === 1) {
      requestStarted();
      await release;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ marker: request.marker }),
    });
  });
  const save = page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Save' });
  const changeTo = async (text: string) => {
    await paragraph.evaluate((element, value) => {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }, text);
    await save.click();
  };

  await changeTo('First snapshot');
  await started;
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await changeTo('Second snapshot');
  await changeTo('Third snapshot');
  await changeTo('Latest snapshot');
  releaseResponse();
  await page.waitForTimeout(300);

  expect(requests.map(({ html }) => html)).toEqual(['First snapshot', 'Latest snapshot']);
  await expect(save).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('status')).toHaveText('Saved');
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}'));
  expect(session.saving).toBe(false);
});

test('handles invalid, missing, and tag-changing active sessions', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__invalid_session_seeded')) {
      sessionStorage.setItem('__invalid_session_seeded', 'true');
      sessionStorage.setItem('astro-wysiwyg-active', '{invalid');
    }
  });
  await page.goto('/resilience/session');
  await expect(page.locator('main > p')).not.toHaveAttribute('contenteditable', 'true');
  await page.evaluate(() => {
    const paragraph = document.querySelector('main > p');
    paragraph?.setAttribute('data-astro-wysiwyg', 'invalid');
    sessionStorage.setItem('astro-wysiwyg-active', JSON.stringify({
      pathname: location.pathname,
      file: 'missing.md',
      start: 0,
    }));
    document.dispatchEvent(new Event('astro:page-load'));
  });
  await expect(page.locator('main > p')).not.toHaveAttribute('contenteditable', 'true');

  await page.reload();
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await page.evaluate(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: false, autosave: true, highlights: true,
    }));
  });
  await page.reload();
  await expect(paragraph).not.toHaveAttribute('contenteditable', 'true');
  await page.evaluate(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: true, highlights: true,
    }));
  });
  await page.reload();
  await paragraph.click();
  await page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}');
    session.tag = 'h2';
    session.html = 'Restored as heading';
    session.suppressAutosave = true;
    sessionStorage.setItem('astro-wysiwyg-active', JSON.stringify(session));
  });
  await page.reload();
  await expect(page.locator('main > h2')).toHaveText('Restored as heading');
  await expect(page.locator('main > h2')).toHaveAttribute('contenteditable', 'true');
});

test('restores sessions with invalid source locations and oversized carets', async ({ page }) => {
  await page.goto('/blocks');
  const first = page.locator('main > p').first();
  await first.click();
  await seedActiveSessionOnNextLoad(page, {
    sourceLocation: 'invalid',
    caret: 99_999,
    html: undefined,
    tag: undefined,
  });
  await page.reload();
  await expect(first).toHaveAttribute('contenteditable', 'true');
  await first.press('Escape');
  const second = page.locator('main > p').nth(1);
  await second.evaluate((element) => {
    const token = element.getAttribute('data-astro-wysiwyg');
    if (!token) throw new Error('Missing source marker');
    const marker = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
    delete marker.original;
    element.setAttribute(
      'data-astro-wysiwyg',
      btoa(JSON.stringify(marker)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    );
    (element as HTMLElement).click();
  });
  await expect(second).toHaveAttribute('contenteditable', 'true');
  await second.press('Escape');
  await page.evaluate(() => {
    const blocks = document.querySelectorAll('main > p');
    blocks[0]?.setAttribute('data-astro-wysiwyg', 'invalid');
    blocks[1]?.setAttribute('data-astro-wysiwyg', btoa('{}'));
    const invalidFormat = blocks[1]?.cloneNode(true) as HTMLElement | undefined;
    invalidFormat?.setAttribute('data-astro-wysiwyg', btoa(JSON.stringify({ file: 'bad.md', start: 0, format: 'bad' })));
    blocks[1]?.after(invalidFormat ?? '');
    sessionStorage.setItem('astro-wysiwyg-active', JSON.stringify({
      pathname: location.pathname,
      file: 'missing.md',
      start: 0,
    }));
    document.dispatchEvent(new Event('astro:page-load'));
  });
  await expect(first).not.toHaveAttribute('contenteditable', 'true');
});

test('does not repeat an in-flight save already reflected after reload', async ({ page }) => {
  await page.goto('/resilience/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unexpected repeat save.' }),
    });
  });

  await seedActiveSessionOnNextLoad(page, {
    sourceOriginal: 'Source before the committed save',
    saving: true,
  });
  await page.reload();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await page.waitForTimeout(700);

  expect(saveRequests).toBe(0);
});

test('retries an in-flight save when its original source is unchanged after reload', async ({ page }) => {
  await page.goto('/resilience/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  const token = await paragraph.getAttribute('data-astro-wysiwyg');
  const sourceOriginal = JSON.parse(Buffer.from(token!, 'base64url').toString('utf8')).original;
  const storedSourceOriginal = await page.evaluate(() => {
    const value = JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}');
    return value.sourceOriginal;
  });
  expect(storedSourceOriginal).toBe(sourceOriginal);
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Restored save retried.' }),
    });
  });

  const pendingHtml = await paragraph.evaluate((element) => `${element.innerHTML} <em>pending</em>`);
  await seedActiveSessionOnNextLoad(page, { html: pendingHtml, saving: true });
  await page.reload();
  await expect(paragraph).toContainText('pending');
  await expect.poll(() => saveRequests).toBe(1);
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('status')).toHaveText('Restored save retried.');
});

test('preserves a debounce-window draft when source changed before reload', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.press('End');
  await paragraph.pressSequentially(' debounce draft');
  const dirty = await page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}');
    return session.dirty;
  });
  expect(dirty).toBe(true);
  await page.evaluate(() => {
    const sourceOriginal = 'Source before an external change';
    const paragraph = document.querySelector<HTMLElement>('main > p');
    const token = paragraph?.getAttribute('data-astro-wysiwyg');
    if (!paragraph || !token) throw new Error('Missing source marker.');
    const marker = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
    marker.original = sourceOriginal;
    paragraph.setAttribute(
      'data-astro-wysiwyg',
      btoa(JSON.stringify(marker)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    );
    const key = 'astro-wysiwyg-active';
    const session = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    session.sourceOriginal = sourceOriginal;
    session.saving = false;
    sessionStorage.setItem(key, JSON.stringify(session));
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: true, highlights: true,
    }));
  });
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.abort();
  });

  await page.reload();
  await expect(paragraph).toContainText('debounce draft');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}')))
    .toMatchObject({ dirty: true, suppressAutosave: true });
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('status')).toHaveText(
    'The source changed since this draft began. Review this block before saving again.',
  );
  await page.waitForTimeout(700);
  expect(saveRequests).toBe(0);
});

test('does not replay stale HTML from a clean session when source changed', async ({ page }) => {
  await page.goto('/resilience/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  const cleanSession = await page.evaluate(() => (
    JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}')
  ));
  expect(cleanSession.dirty).toBe(false);
  await paragraph.press('Escape');
  await page.evaluate((session) => {
    session.dirty = false;
    session.saving = false;
    session.sourceOriginal = 'Source before an external change';
    session.html = 'Stale clean session HTML';
    sessionStorage.setItem('astro-wysiwyg-active', JSON.stringify(session));
  }, cleanSession);
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.abort();
  });

  await page.reload();
  await expect(paragraph).not.toContainText('Stale clean session HTML');
  await expect(paragraph).toContainText('Keep this pending edit stable across an Astro reload.');
  await page.waitForTimeout(700);
  expect(saveRequests).toBe(0);
});

test('preserves an in-flight draft without overwriting conflicting source after reload', async ({ page }) => {
  await page.goto('/resilience/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.abort();
  });

  const pendingHtml = await paragraph.evaluate((element) => `${element.innerHTML} <em>pending</em>`);
  await seedActiveSessionOnNextLoad(page, {
    sourceOriginal: 'Source before an external change',
    html: pendingHtml,
    saving: true,
  });
  await page.reload();
  await expect(paragraph).toContainText('pending');
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('status')).toHaveText(
    'The source changed since this draft began. Review this block before saving again.',
  );
  await page.waitForTimeout(700);
  expect(saveRequests).toBe(0);
});

test('keeps editing active when Done cannot save', async ({ page }) => {
  await page.goto('/resilience/save-failure');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Simulated save failure.' }),
    });
  });
  await paragraph.pressSequentially(' unsaved');

  const toolbar = page.locator('#astro-wysiwyg-toolbar');
  await toolbar.getByRole('button', { name: 'Done' }).click();

  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await expect(toolbar.getByRole('status')).toHaveText('Simulated save failure.');
});

test('times out a stalled save without blocking the next attempt', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/save-failure');
  await page.clock.install();
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.evaluate((element) => {
    element.textContent += ' waiting';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  let releaseResponse: () => void = () => undefined;
  let requestStarted: () => void = () => undefined;
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  let requests = 0;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    requests += 1;
    if (requests === 1) {
      requestStarted();
      await release;
      await route.abort().catch(() => undefined);
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Retry reached the server.' }),
    });
  });

  try {
    const toolbar = page.locator('#astro-wysiwyg-toolbar');
    await toolbar.getByRole('button', { name: 'Done' }).click();
    await started;
    await page.clock.fastForward(10_001);

    await expect(toolbar.getByRole('status')).toHaveText('Saving timed out. Try again.', { timeout: 500 });
    await expect(paragraph).toHaveAttribute('contenteditable', 'true');
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}'));
    expect(session.saving).toBe(false);
    expect(session.dirty).toBe(true);
    expect(session.html).toContain('waiting');

    await toolbar.getByRole('button', { name: 'Save' }).click();
    await expect(toolbar.getByRole('status')).toHaveText('Retry reached the server.');
    expect(requests).toBe(2);
  } finally {
    releaseResponse();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('switches blocks after saving the pending manual edit', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/guards');
  const paragraphs = page.locator('main > p');
  const first = paragraphs.first();
  const second = paragraphs.nth(1);
  await first.click();
  await first.evaluate((element) => {
    element.textContent += ' saved before switching';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ marker: request.marker }),
    });
  });

  await second.evaluate((element) => element.click());

  await expect(first).not.toHaveAttribute('contenteditable', 'true');
  await expect(second).toHaveAttribute('contenteditable', 'true');
  await expect(second).toBeFocused();
});

test('keeps the previous block recoverable when switching blocks cannot save', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/guards');
  const paragraphs = page.locator('main > p');
  const first = paragraphs.first();
  const second = paragraphs.nth(1);
  await first.click();
  await first.evaluate((element) => {
    element.textContent += ' unsaved';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  await page.route('**/_astro-wysiwyg/save', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Switch save failed.' }),
  }));

  await second.evaluate((element) => element.click());

  const toolbar = page.locator('#astro-wysiwyg-toolbar');
  await expect(toolbar.getByRole('status')).toHaveText('Switch save failed.');
  await expect(first).toHaveAttribute('contenteditable', 'true');
  await expect(first).toHaveAttribute('data-astro-wysiwyg-active', '');
  await expect(second).not.toHaveAttribute('contenteditable', 'true');
  await expect(first).toBeFocused();
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}'));
  expect(session.html).toContain('unsaved');
});

test('keeps editing active when content changes while Done is saving', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/save-failure');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.evaluate((element) => {
    element.textContent += ' first change';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  let releaseResponse: () => void = () => undefined;
  let requestStarted: () => void = () => undefined;
  let responseFinished: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const finished = new Promise<void>((resolve) => { responseFinished = resolve; });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    requestStarted();
    await release;
    const request = route.request().postDataJSON();
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ marker: request.marker }),
    });
    responseFinished();
  });
  await page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Done' }).click();
  await started;
  await paragraph.evaluate((element) => {
    element.textContent += ' continued';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  releaseResponse();
  await finished;
  await page.waitForTimeout(50);
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('status')).toHaveText('Unsaved');
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
});

test('keeps unsaved editing active when its source marker disappears', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/save-failure');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.evaluate((element) => {
    element.textContent += ' without marker';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    element.removeAttribute('data-astro-wysiwyg');
    const shadow = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot;
    (shadow?.querySelector('[data-action="save"]') as HTMLButtonElement)?.click();
  });
  const toolbar = page.locator('#astro-wysiwyg-toolbar');
  await expect(toolbar.getByRole('status')).toHaveText('Missing source marker.');
  await toolbar.getByRole('button', { name: 'Done' }).click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
});

function sessionStorageMarker(session: { file?: string; start?: number }): string {
  const marker = {
    version: 1,
    file: session.file ?? 'src/pages/pending.md',
    start: session.start ?? 0,
    end: session.start ?? 0,
    original: '',
    format: 'markdown',
    tag: 'p',
  };
  return Buffer.from(JSON.stringify(marker)).toString('base64url');
}

test('announces keyboard editing without replacing source block semantics', async ({ page }) => {
  await page.goto('/');
  const heading = page.getByRole('heading', { name: 'Editable Astro page' });
  await expect(heading).not.toHaveAttribute('role');
  await expect(heading).toHaveAttribute('aria-describedby', 'astro-wysiwyg-edit-instructions');
  await expect(page.locator('#astro-wysiwyg-edit-instructions')).toHaveText(
    'Editable source content. Press Enter to edit. Press Alt+Up or Alt+Down to move between editable blocks.',
  );

  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'main > h1' });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const accessibleHeading = nodes.find((node) => !node.ignored);
  expect(accessibleHeading?.role?.value).toBe('heading');
  expect(accessibleHeading?.name?.value).toBe('Editable Astro page');
  expect(accessibleHeading?.description?.value).toBe(
    'Editable source content. Press Enter to edit. Press Alt+Up or Alt+Down to move between editable blocks.',
  );
  await cdp.detach();

  await heading.press('Enter');
  await expect(heading).not.toHaveAttribute('aria-describedby');
  await heading.press('Escape');
  await expect(heading).toHaveAttribute('aria-describedby', 'astro-wysiwyg-edit-instructions');

  await page.evaluate(() => {
    const authorDescription = document.createElement('span');
    authorDescription.id = 'author-description';
    authorDescription.hidden = true;
    authorDescription.textContent = 'Author description.';
    document.body.append(authorDescription);
    const sourceHeading = document.querySelector('main > h1')!;
    sourceHeading.setAttribute(
      'aria-describedby',
      `author-description ${sourceHeading.getAttribute('aria-describedby')}`,
    );
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: false, autosave: true, highlights: true },
    }));
  });
  await expect(heading).toHaveAttribute('aria-describedby', 'author-description');

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: true, autosave: true, highlights: true },
    }));
  });
  await expect(heading).toHaveAttribute(
    'aria-describedby',
    'author-description astro-wysiwyg-edit-instructions',
  );
});

test('uses one roving tab stop for long-page editable blocks', async ({ page }) => {
  await page.goto('/focus-order');
  const paragraphs = page.locator('main > p');
  await expect(paragraphs).toHaveCount(8);
  await expect(page.locator('main > p[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('main > p[tabindex="-1"]')).toHaveCount(6);
  await expect(paragraphs.nth(3)).toHaveAttribute('tabindex', '4');

  await paragraphs.first().focus();
  await paragraphs.first().press('Alt+ArrowDown');
  await expect(paragraphs.nth(1)).toBeFocused();
  await expect(paragraphs.first()).toHaveAttribute('tabindex', '-1');
  await expect(paragraphs.nth(1)).toHaveAttribute('tabindex', '0');
  await paragraphs.nth(1).press('Alt+ArrowDown');
  await expect(paragraphs.nth(2)).toBeFocused();
  await paragraphs.nth(2).press('Alt+ArrowDown');
  await expect(paragraphs.nth(3)).toBeFocused();
  await expect(paragraphs.nth(3)).toHaveAttribute('tabindex', '4');
  await paragraphs.nth(3).press('Alt+ArrowDown');
  await expect(paragraphs.nth(4)).toBeFocused();
  await expect(paragraphs.nth(4)).toHaveAttribute('tabindex', '0');
  await paragraphs.first().focus();
  await paragraphs.first().press('Alt+ArrowDown');
  await paragraphs.nth(1).press('Alt+ArrowUp');
  await expect(paragraphs.first()).toBeFocused();
  await paragraphs.first().press('Alt+ArrowUp');
  await expect(paragraphs.last()).toBeFocused();
  await paragraphs.last().press('Tab');
  await expect(page.getByRole('link', { name: 'After editable blocks' })).toBeFocused();

  await paragraphs.nth(4).click();
  await expect(paragraphs.nth(4)).toHaveAttribute('contenteditable', 'true');
  await expect(paragraphs.nth(4)).toHaveAttribute('tabindex', '0');
  await expect(page.locator('main > p[tabindex="0"]')).toHaveCount(1);
  await paragraphs.nth(4).press('Escape');
  await paragraphs.nth(4).press('Tab');
  await expect(page.getByRole('link', { name: 'After editable blocks' })).toBeFocused();

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: false, autosave: true, highlights: true },
    }));
  });
  await expect(page.locator('main > p[data-wysiwyg-added-tabindex]')).toHaveCount(0);
  await expect(paragraphs.nth(3)).toHaveAttribute('tabindex', '4');
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: true, autosave: true, highlights: true },
    }));
  });
  await expect(page.locator('main > p[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('main > p[tabindex="-1"]')).toHaveCount(6);
  await expect(paragraphs.nth(3)).toHaveAttribute('tabindex', '4');
});

test('supports keyboard activation, formatting, lists, toolbar focus, save, and finish', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/keyboard');
  const paragraph = page.locator('main > p');
  await paragraph.focus();
  await paragraph.press('Enter');
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await paragraph.press('Control+i');
  await paragraph.press('Control+z');
  await paragraph.press('Control+Shift+8');
  await page.locator('main > ul').press('Control+Shift+8');
  await page.locator('main > p').press('Control+Shift+7');
  await page.locator('main > ol').press('Control+Shift+7');
  const restored = page.locator('main > p');
  await restored.press('Alt+F10');
  const firstEnabledControl = page.locator('#astro-wysiwyg-toolbar').locator('[data-toolbar-item]:not(:disabled)').first();
  await expect(firstEnabledControl).toBeFocused();
  await restored.focus();
  await restored.press('Control+s');
  await restored.press('End');
  await restored.pressSequentially(' save on done');
  await page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Done' }).click();
  await expect(restored).not.toHaveAttribute('contenteditable', 'true');
});

test('supports roving toolbar focus, named menus, tooltips, states, and focus restoration', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/keyboard');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  const toolbar = editor.getByRole('toolbar', { name: 'Edit text' });
  const controls = toolbar.locator('[data-toolbar-item]:not([hidden])');
  await expect(controls).toHaveCount(11);
  await expect(toolbar.locator('[data-toolbar-item][tabindex="0"]')).toHaveCount(1);

  await paragraph.press('Alt+F10');
  const style = toolbar.getByRole('button', { name: 'Text style: Paragraph' });
  await expect(style).toBeFocused();
  await style.press('ArrowRight');
  const bold = toolbar.getByRole('button', { name: 'Bold' });
  await expect(bold).toBeFocused();
  await expect(toolbar.getByRole('tooltip')).toHaveText('Bold (Ctrl/Cmd+B)');
  await bold.press('ArrowLeft');
  await expect(style).toBeFocused();
  await style.press('ArrowRight');
  await expect(bold).toBeFocused();
  await bold.press('Escape');
  await expect(toolbar.getByRole('tooltip')).not.toBeVisible();
  await expect(bold).toBeFocused();
  await bold.press('End');
  const done = toolbar.getByRole('button', { name: 'Done' });
  await expect(done).toBeFocused();
  await done.press('ArrowRight');
  await expect(style).toBeFocused();
  await style.press('End');
  await paragraph.focus();
  await paragraph.press('Alt+F10');
  await expect(done).toBeFocused();
  await done.press('Home');
  await expect(style).toBeFocused();

  await style.press('Enter');
  const styleMenu = toolbar.getByRole('menu', { name: 'Text style' });
  await expect(styleMenu).toBeVisible();
  await expect(styleMenu.getByRole('menuitem', { name: 'Paragraph' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(styleMenu.getByRole('menuitem', { name: /Heading 6/ })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(styleMenu.getByRole('menuitem', { name: 'Paragraph' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(styleMenu.getByRole('menuitem', { name: /Heading 1/ })).toBeFocused();
  await page.keyboard.press('End');
  await expect(styleMenu.getByRole('menuitem', { name: /Heading 6/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(styleMenu).not.toBeVisible();
  await expect(style).toBeFocused();
  await style.press('ArrowUp');
  await expect(styleMenu.getByRole('menuitem', { name: /Heading 6/ })).toBeFocused();
  await style.evaluate((button) => button.click());
  await expect(styleMenu).not.toBeVisible();
  await expect(style).toBeFocused();

  const insert = toolbar.getByRole('button', { name: 'Insert' });
  await insert.focus();
  await insert.press('Space');
  const insertMenu = toolbar.getByRole('menu', { name: 'Insert' });
  await expect(insertMenu.getByRole('menuitem', { name: 'Paragraph below' })).toBeFocused();
  await expect(insertMenu.getByRole('menuitem', { name: 'Image' })).toBeEnabled();
  await expect(insertMenu.getByRole('menuitem', { name: 'Video' })).toBeEnabled();
  await page.keyboard.press('ArrowDown');
  await expect(insertMenu.getByRole('menuitem', { name: 'Image' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(insert).toBeFocused();
  await insert.press('ArrowDown');
  await expect(insertMenu.getByRole('menuitem', { name: 'Paragraph below' })).toBeFocused();
  await style.evaluate((button) => button.click());
  await expect(insertMenu).not.toBeVisible();
  await expect(styleMenu).toBeVisible();
  await page.keyboard.press('Escape');

  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const link = toolbar.getByRole('button', { name: 'Link' });
  await link.click();
  const linkDialog = toolbar.getByRole('dialog', { name: 'Edit link' });
  await expect(linkDialog.getByRole('textbox', { name: 'Link URL' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(linkDialog).not.toBeVisible();
  await expect(link).toBeFocused();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await link.click();
  await expect(linkDialog).toBeVisible();
  await style.evaluate((button) => button.click());
  await expect(linkDialog).not.toBeVisible();
  await expect(styleMenu).toBeVisible();
  await page.keyboard.press('Escape');

  await bold.hover();
  await expect(toolbar.getByRole('tooltip')).toBeVisible();
  await toolbar.getByRole('tooltip').hover();
  await expect(toolbar.getByRole('tooltip')).toBeVisible();
  await bold.hover();
  await expect(toolbar.getByRole('tooltip')).toBeVisible();
  await toolbar.getByRole('tooltip').hover();
  await page.mouse.move(0, 0);
  await expect(toolbar.getByRole('tooltip')).not.toBeVisible();
  await bold.focus();
  await bold.press('Tab');
  await expect(bold).not.toBeFocused();
});

test('ignores non-editor events and storage failures without stopping editing', async ({ page }) => {
  await page.goto('/keyboard');
  await page.evaluate(() => {
    document.dispatchEvent(new Event('astro-wysiwyg:preferences'));
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body.dispatchEvent(new Event('input', { bubbles: true }));
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
  });
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.click();
  await paragraph.pressSequentially(' still editable');
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
});

test('preserves one editor instance across ClientRouter document swaps', async ({ page }) => {
  await page.goto('/router-one');
  const host = page.locator('#astro-wysiwyg-toolbar');
  await host.evaluate((element) => { element.dataset.instance = 'original'; });
  const firstParagraph = page.getByText('First routed block.');
  await firstParagraph.click();
  await expect(firstParagraph).toHaveAttribute('contenteditable', 'true');
  await expect(host.getByRole('toolbar', { name: 'Edit text' })).toBeVisible();

  await page.getByRole('link', { name: 'Open router page two' }).click();
  await expect(page).toHaveURL(/\/router-two$/);
  await expect(page.getByRole('heading', { name: 'Router page two' })).toBeVisible();
  await expect(host).toHaveCount(1);
  await expect(host).toHaveAttribute('data-instance', 'original');
  await expect(page.locator('#astro-wysiwyg-edit-instructions')).toHaveCount(1);
  await expect(page.locator('style[data-astro-wysiwyg-style]')).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute('data-astro-wysiwyg-enabled', '');

  let sourceLookups = 0;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    sourceLookups += 1;
    await route.continue();
  });
  const paragraph = page.getByText('Second routed block.');
  await expect(paragraph).toHaveAttribute('data-wysiwyg-source-file', /.+/);
  await paragraph.evaluate((element) => element.removeAttribute('data-astro-wysiwyg'));
  await paragraph.click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  expect(sourceLookups).toBe(1);

  await page.getByRole('link', { name: 'Return to router page one' }).click();
  await expect(page).toHaveURL(/\/router-one$/);
  await expect(host).toHaveCount(1);
  await expect(host).toHaveAttribute('data-instance', 'original');
  await expect(page.locator('#astro-wysiwyg-edit-instructions')).toHaveCount(1);
  await expect(page.locator('style[data-astro-wysiwyg-style]')).toHaveCount(1);
});

test('handles duplicate setup, page events, open panels, block switches, and disabling while active', async ({ page }) => {
  await page.goto('/resilience/resilience');
  await page.evaluate(async () => {
    const clientUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => url.includes('/dist/client.js'));
    if (!clientUrl) throw new Error('Missing client module URL');
    const client = await import(clientUrl);
    client.startEditor({ endpoint: '/_astro-wysiwyg/save', saveDelay: 500 });
    document.dispatchEvent(new Event('astro:page-load'));
    document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot?.dispatchEvent(new Event('keydown', { bubbles: true }));
    document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot?.querySelector('[role="status"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );
  });
  const paragraphs = page.locator('main > p');
  await paragraphs.first().click();
  await page.evaluate(() => document.dispatchEvent(new Event('astro:page-load')));

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' })).toBeVisible();
  await paragraphs.nth(1).evaluate((element) => element.click());
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' })).not.toBeVisible();

  await paragraphs.first().click();
  await paragraphs.first().evaluate((element) => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Link' }).click();
  await paragraphs.nth(1).evaluate((element) => element.click());
  await expect(editor.getByRole('dialog', { name: 'Edit link' })).not.toBeVisible();

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: true, autosave: false, highlights: true },
    }));
  });
  await paragraphs.first().click();
  await paragraphs.first().pressSequentially(' changed');
  await paragraphs.nth(1).evaluate((element) => element.click());
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: false, autosave: false, highlights: true },
    }));
  });
  await expect(paragraphs.nth(1)).not.toHaveAttribute('contenteditable', 'true');
  await paragraphs.nth(1).press('Control+b');
});

test('exercises guarded toolbar, link, marker-resolution, and finish paths', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/resilience/guards');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await page.evaluate(() => {
    dispatchEvent(new Event('scroll'));
    const shadow = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot;
    shadow?.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    shadow?.dispatchEvent(new FocusEvent('focusin'));
    shadow?.dispatchEvent(new FocusEvent('focusout'));
    shadow?.dispatchEvent(new Event('pointerover'));
    shadow?.dispatchEvent(new Event('pointerout'));
    shadow?.dispatchEvent(new PointerEvent('pointerover'));
    shadow?.dispatchEvent(new PointerEvent('pointerout'));
    shadow?.querySelector('[role="status"]')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    (shadow?.querySelector('[data-command="bold"]') as HTMLButtonElement)?.click();
  });
  let first = page.locator('main > p').first();
  await first.click();
  await page.evaluate(() => {
    document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await expect(first).not.toHaveAttribute('contenteditable', 'true');
  await first.click();
  await page.evaluate(() => {
    const shadow = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot;
    const unknown = document.createElement('button');
    unknown.dataset.action = 'unknown';
    shadow?.append(unknown);
    unknown.click();
    unknown.remove();
  });
  await editor.getByRole('button', { name: 'Paragraph' }).click();
  await editor.getByRole('menuitem', { name: 'Paragraph' }).click();
  await editor.getByRole('button', { name: 'Bold' }).click();

  await first.evaluate((element) => {
    getSelection()?.removeAllRanges();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  });
  await first.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await editor.getByRole('button', { name: 'Link' }).click();
  const linkInput = editor.getByRole('textbox', { name: 'Link URL' });
  await linkInput.fill('');
  await editor.getByRole('button', { name: 'Apply link' }).click();
  await expect(editor.getByRole('alert')).toContainText('Enter an http');
  await linkInput.fill('/valid');
  await first.evaluate((element) => { element.textContent = 'Collapsed guarded block'; });
  await editor.getByRole('button', { name: 'Apply link' }).click();
  await expect(editor.getByRole('alert')).toContainText('Select text');
  await linkInput.press('Escape');

  await first.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await editor.getByRole('button', { name: 'Link' }).click();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter')));
  await expect(editor.getByRole('dialog', { name: 'Edit link' })).not.toBeVisible();
  await page.evaluate(() => {
    const shadow = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot;
    (shadow?.querySelector('[data-action="save"]') as HTMLButtonElement)?.click();
    (shadow?.querySelector('[data-action="done"]') as HTMLButtonElement)?.click();
  });
  await expect(editor.getByRole('dialog', { name: 'Edit frontmatter' })).not.toBeVisible();

  await first.click();
  await first.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.evaluate(() => {
    const shadow = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot;
    (shadow?.querySelector('[data-action="link"]') as HTMLButtonElement)?.click();
    (shadow?.querySelector('[data-action="done"]') as HTMLButtonElement)?.click();
  });
  await page.evaluate(() => {
    dispatchEvent(new Event('scroll'));
    const shadow = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot;
    (shadow?.querySelector('[data-action="save-frontmatter"]') as HTMLButtonElement)?.click();
  });

  first = page.locator('main > p').first();
  await first.evaluate((element) => element.setAttribute('data-astro-wysiwyg', 'invalid'));
  await first.click();
  await expect(first).toHaveAttribute('contenteditable', 'true');
  await first.press('Escape');
  await first.evaluate((element) => {
    element.removeAttribute('data-astro-wysiwyg');
    element.setAttribute('data-wysiwyg-source-file', '/src/pages/guards.astro');
    element.setAttribute('data-wysiwyg-source-loc', '1:1');
  });
  await page.route('**/_astro-wysiwyg/save', (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: '{}',
  }));
  await first.press('Enter');
  await expect(first).not.toHaveAttribute('contenteditable', 'true');
});

test('rejects failed and aborted dynamic source-marker lookups', async ({ page }) => {
  await page.goto('/resilience/guards');
  const blocks = page.locator('main > p');
  await blocks.evaluateAll((elements) => {
    for (const [index, element] of elements.entries()) {
      element.removeAttribute('data-astro-wysiwyg');
      (element as HTMLElement).dataset.wysiwygSourceFile = '/src/pages/guards.astro';
      (element as HTMLElement).dataset.wysiwygSourceLoc = `${index + 1}:1`;
    }
  });
  await page.route('**/_astro-wysiwyg/save', (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: '{}',
  }));
  await blocks.first().evaluate((element) => element.click());
  await page.waitForTimeout(100);
  await expect(blocks.first()).not.toHaveAttribute('contenteditable', 'true');
  await page.unroute('**/_astro-wysiwyg/save');
  await page.route('**/_astro-wysiwyg/save', (route) => route.abort());
  await blocks.nth(1).evaluate((element) => element.click());
  await page.waitForTimeout(100);
  await expect(blocks.nth(1)).not.toHaveAttribute('contenteditable', 'true');
});

test('edits interactive Astro text without triggering its native or application action', async ({ page }) => {
  await page.goto('/interactive');
  await page.evaluate(() => {
    document.body.dataset.interactiveActions = '0';
    const recordAction = (event: Event) => {
      if (event.type === 'submit') event.preventDefault();
      document.body.dataset.interactiveActions = String(
        Number(document.body.dataset.interactiveActions) + 1,
      );
    };
    document.querySelector('button')?.addEventListener('click', recordAction);
    document.querySelector('form')?.addEventListener('submit', recordAction);
    document.querySelector('label')?.addEventListener('click', recordAction);
    document.querySelector('summary')?.addEventListener('click', recordAction);
  });

  const button = page.locator('main button');
  await button.click();
  await expect(button).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-interactive-actions', '0');
  await button.press('Escape');

  const label = page.locator('main label');
  await label.click();
  await expect(label).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('#editable-checkbox')).not.toBeChecked();
  await expect(page.locator('body')).toHaveAttribute('data-interactive-actions', '0');
  await label.press('Escape');

  const summary = page.locator('main summary');
  await summary.click();
  await expect(summary).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('details')).not.toHaveAttribute('open', '');
  await expect(page.locator('body')).toHaveAttribute('data-interactive-actions', '0');
});

test('maps marked list items back to their editable parent list', async ({ page }) => {
  await page.goto('/multi-list');
  const list = page.locator('main > ul');
  const item = list.locator('li').first();
  const marker = await list.getAttribute('data-astro-wysiwyg');
  await item.evaluate((element, token) => element.setAttribute('data-astro-wysiwyg', String(token)), marker);
  await item.click();
  await expect(list).toHaveAttribute('contenteditable', 'true');
});

test('leaves dynamic Astro expressions uneditable', async ({ page }) => {
  await page.goto('/');
  const dynamic = page.locator('p').filter({ hasText: 'Dynamic text' });
  await expect(dynamic).not.toHaveAttribute('data-astro-wysiwyg', /.+/);
  await dynamic.click();
  await expect(dynamic).not.toHaveAttribute('contenteditable', 'true');
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
  await page.waitForTimeout(2_500);
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

test('validates, applies, cancels, and removes links', async ({ page }) => {
  await page.goto('/link-errors');
  let paragraph = page.locator('main > p');
  const existing = paragraph.getByRole('link', { name: 'link' });
  await paragraph.click();
  await existing.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Link' }).click();
  await editor.getByRole('button', { name: 'Remove link' }).click();
  await expect(paragraph.getByRole('link')).toHaveCount(0);
  await page.waitForTimeout(1_000);
  paragraph = page.locator('main > p');
  await paragraph.click();
  await paragraph.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text: Text | null = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode as Text;
      if (candidate.data.includes('plain')) {
        text = candidate;
        break;
      }
    }
    if (!text) throw new Error('Missing plain text');
    const start = text.data.indexOf('plain');
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 5);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await paragraph.press('Control+k');
  const input = editor.getByRole('textbox', { name: 'Link URL' });
  await input.evaluate((element) => { (element as HTMLInputElement).value = '\u0001'; });
  await editor.getByRole('button', { name: 'Apply link' }).click();
  await expect(editor.getByRole('alert')).toContainText('Enter an http');
  await input.fill('javascript:alert(1)');
  await input.press('Enter');
  await expect(editor.getByRole('alert')).toContainText('Enter an http');
  await input.fill('http://[');
  await input.press('Enter');
  await expect(editor.getByRole('alert')).toContainText('Enter an http');
  await input.fill('/new');
  await input.press('Enter');
  await expect(paragraph.getByRole('link', { name: 'plain' })).toHaveAttribute('href', '/new');
  await paragraph.getByRole('link', { name: 'plain' }).click();
  await editor.getByRole('button', { name: 'Link' }).click();
  await editor.getByRole('button', { name: 'Cancel link' }).click();
});

test('reports frontmatter context, load, and save errors', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  let dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog.getByRole('alert')).toContainText('Open a Markdown or MDX page');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/article');
  let failRead = true;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const body = route.request().postDataJSON();
    if (body.frontmatter === 'read' && failRead) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Load failed.' }) });
      return;
    }
    if (body.frontmatter === 'read') return route.continue();
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Save failed.' }) });
  });
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog.getByRole('alert')).toHaveText('Load failed.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  failRead = false;
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  await dialog.getByRole('textbox', { name: 'title' }).fill('Will not save');
  await dialog.getByRole('button', { name: 'Save frontmatter' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Save failed.');
  await dialog.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('astro-wysiwyg-frontmatter-draft'))).toBeNull();
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:open-frontmatter'));
  });
  await dialog.getByRole('button', { name: 'Save frontmatter' }).click();
  await expect(dialog).not.toBeVisible();
});

test('keeps blocks active when structural requests fail or deletion is cancelled', async ({ page }) => {
  await page.goto('/blocks');
  const first = page.locator('main > p').first();
  await first.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
    detail: { enabled: true, autosave: false, highlights: true },
  })));
  await first.pressSequentially(' unsaved');
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Structure failed.' }) });
  });
  await editor.getByRole('button', { name: 'Insert' }).click();
  await editor.getByRole('menuitem', { name: 'Paragraph below' }).click();
  await expect(editor.getByRole('status')).toHaveText('Structure failed.');
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Delete block' }).click();
  await expect(first).toHaveAttribute('contenteditable', 'true');
  await first.evaluate((element) => {
    element.textContent = 'First block.';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  });
  await editor.getByRole('button', { name: 'Insert' }).click();
  await editor.getByRole('menuitem', { name: 'Paragraph below' }).click();
  await expect(editor.getByRole('status')).toHaveText('Structure failed.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await editor.getByRole('button', { name: 'Delete block' }).click();
  await expect(first).toHaveAttribute('contenteditable', 'true');
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Delete block' }).click();
  await expect(editor.getByRole('status')).toHaveText('Structure failed.');
  await expect(first).toHaveAttribute('contenteditable', 'true');
});

test('handles a failed delete after its original DOM detaches', async ({ page }) => {
  await page.goto('/resilience/detached');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  let releaseResponse: () => void = () => undefined;
  let requestStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const request = route.request().postDataJSON();
    if (request.operation !== 'delete') return route.continue();
    requestStarted();
    await release;
    await route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Detached delete failed.' }),
    });
  });
  page.once('dialog', (dialog) => dialog.accept());
  const deletion = page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Delete block' }).click();
  await started;
  await paragraph.evaluate((element) => element.remove());
  releaseResponse();
  await deletion;
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('status')).toHaveText('Detached delete failed.');
});

test('remembers an inserted block when its original DOM detaches before the response', async ({ page }) => {
  await page.goto('/resilience/detached');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  let releaseResponse: () => void = () => undefined;
  let requestStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    const request = route.request().postDataJSON();
    if (request.operation !== 'insert-after') return route.continue();
    requestStarted();
    await release;
    const marker = JSON.parse(Buffer.from(request.marker, 'base64url').toString('utf8'));
    marker.start += marker.original.length + 2;
    marker.end = marker.start + 'New paragraph'.length;
    marker.original = 'New paragraph';
    marker.tag = 'p';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ marker: Buffer.from(JSON.stringify(marker)).toString('base64url') }),
    });
  });
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Insert' }).click();
  const add = editor.getByRole('menuitem', { name: 'Paragraph below' }).click();
  await started;
  await paragraph.evaluate((element) => element.remove());
  releaseResponse();
  await add;
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('status')).toHaveText('Block added');
  expect(await page.evaluate(() => sessionStorage.getItem('astro-wysiwyg-active'))).toContain('New paragraph');
});

test('adds, edits, and deletes a source-backed block', async ({ page }) => {
  const before = await readFile(blocksFile, 'utf8');
  await page.goto('/blocks');
  const first = page.locator('main > p').first();
  await first.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');

  await editor.getByRole('button', { name: 'Insert' }).click();
  await editor.getByRole('menuitem', { name: 'Paragraph below' }).click();

  await expect.poll(async () => readFile(blocksFile, 'utf8')).toContain(
    'First block.\n\nNew paragraph\n\nSecond block.',
  );
  let added = page.locator('main > p').filter({ hasText: 'New paragraph' });
  await expect(added).toHaveAttribute('contenteditable', 'true');
  await added.press('Control+a');
  await added.pressSequentially('Inserted block.');
  await expect.poll(async () => readFile(blocksFile, 'utf8')).toContain('Inserted block.');
  await page.waitForTimeout(1_000);
  added = page.locator('main > p').filter({ hasText: 'Inserted block.' });
  await added.click();
  page.once('dialog', (dialog) => dialog.accept());

  await editor.getByRole('button', { name: 'Delete block' }).click();

  await expect.poll(async () => readFile(blocksFile, 'utf8')).toBe(before);
  await expect(page.locator('main > p')).toHaveCount(2);
});

test('offers all six heading levels in the toolbar', async ({ page }) => {
  await page.goto('/headings');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  const editor = page.locator('#astro-wysiwyg-toolbar');

  await editor.getByRole('button', { name: 'Text style: Paragraph' }).click();
  await editor.getByRole('menuitem', { name: 'Heading 6' }).click();
  await expect(editor.getByRole('button', { name: 'Text style: Heading 6' })).toBeVisible();

  await expect.poll(async () => readFile(headingFile, 'utf8')).toContain(
    '###### Turn this paragraph into a level six heading.',
  );
  const heading = page.locator('main > h6');
  await expect(heading).toContainText('level six heading');
  await heading.click();
  await editor.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('main > p')).toContainText('level six heading');
});

test('turns a multi-item list back into one paragraph', async ({ page }) => {
  await page.goto('/multi-list');
  const list = page.locator('main > ul');
  await list.locator('li').first().click();
  await expect(list).toHaveAttribute('contenteditable', 'true');
  await page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Bullet list' }).click();
  const paragraph = page.locator('main > p');
  await expect(paragraph).toContainText('First item');
  await expect(paragraph.locator('br')).toHaveCount(1);
});

test('changes a Markdown paragraph between bullet and numbered lists', async ({ page }) => {
  await page.goto('/lists');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await editor.getByRole('button', { name: 'Bullet list' }).click();
  await expect(editor.getByRole('button', { name: 'Bullet list' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => readFile(listFile, 'utf8')).toContain('- Turn this paragraph into a list.');

  await page.waitForTimeout(2_500);
  const list = page.locator('main > ul');
  await expect(list).toHaveAttribute('contenteditable', 'true');
  await editor.getByRole('button', { name: 'Numbered list' }).click();
  await expect.poll(async () => readFile(listFile, 'utf8')).toContain('1. Turn this paragraph into a list.');
});

test('undoes a saved wrapped-paragraph edit without an Astro reload or repeat write', async ({ page }) => {
  const before = await readFile(cardFile, 'utf8');
  await page.goto('/articles/example');
  const paragraph = page.locator('[data-article-version-panel="latest"] > p');
  await paragraph.click();
  await paragraph.press('End');
  await paragraph.pressSequentially(' XUNDOX');
  await expect.poll(async () => readFile(cardFile, 'utf8')).toContain('XUNDOX');
  await page.waitForTimeout(2_500);

  await page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Undo' }).click();

  await expect.poll(async () => readFile(cardFile, 'utf8')).toBe(before);
});

test('undoes a saved card edit without an Astro reload', async ({ page }) => {
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

test('defaults invalid stored preference fields independently', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: 'yes', autosave: 1, highlights: null,
    }));
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-astro-wysiwyg-enabled', '');
  await expect(page.locator('html')).toHaveAttribute('data-astro-wysiwyg-highlights', '');
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

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('astro-wysiwyg:preferences', {
      detail: { enabled: false, autosave: false, highlights: false },
    }));
  });
  await expect(heading).not.toHaveAttribute('contenteditable', 'true');
  await expect(heading).not.toHaveAttribute('aria-describedby');
});
