import { expect, test } from './coverage.ts';
import { readFile } from 'node:fs/promises';

const astroFile = '.tmp/e2e-site/src/pages/index.astro';
const markdownFile = '.tmp/e2e-site/src/pages/article.md';
const cardFile = '.tmp/e2e-site/src/content/articles/example/index.md';
const linkFile = '.tmp/e2e-site/src/pages/links.md';
const listFile = '.tmp/e2e-site/src/pages/lists.md';
const headingFile = '.tmp/e2e-site/src/pages/headings.md';
const queueFile = '.tmp/e2e-site/src/pages/queue.md';
const blocksFile = '.tmp/e2e-site/src/pages/blocks.md';

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
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await expect(editor.getByRole('button', { name: 'Add block below' })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Delete block' })).toBeDisabled();
  await title.press('End');
  await title.pressSequentially(' updated');

  await expect.poll(async () => readFile(markdownFile, 'utf8')).toContain('title: Markdown fixture updated');
  await page.waitForTimeout(2_000);
  await expect(title).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('wysiwyg-loads'))).toBe('2');

  await page.reload();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  expect(await page.evaluate(() => sessionStorage.getItem('wysiwyg-loads'))).toBe('3');
  await editor.getByRole('button', { name: 'Add block below' }).evaluate((button) => {
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

test('queues continued Markdown edits behind an in-flight save', async ({ page }) => {
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    saveRequests += 1;
    if (saveRequests === 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await page.goto('/queue');
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

test('handles invalid, missing, and tag-changing active sessions', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('__invalid_session_seeded')) {
      sessionStorage.setItem('__invalid_session_seeded', 'true');
      sessionStorage.setItem('astro-wysiwyg-active', '{invalid');
    }
  });
  await page.goto('/session');
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
  await page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}');
    session.sourceLocation = 'invalid';
    session.caret = 99_999;
    sessionStorage.setItem('astro-wysiwyg-active', JSON.stringify(session));
  });
  await page.reload();
  await expect(first).toHaveAttribute('contenteditable', 'true');
  await first.press('Escape');
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

test('does not resave an in-flight edit restored after an Astro reload', async ({ page }) => {
  await page.goto('/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  const session = await page.evaluate(() => {
    const key = 'astro-wysiwyg-active';
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    value.html = `${value.html} <em>pending</em>`;
    value.saving = true;
    sessionStorage.setItem(key, JSON.stringify(value));
    return value;
  });
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', async (route) => {
    saveRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ marker: sessionStorageMarker(session) }),
    });
  });

  await page.reload();
  await expect(paragraph).toContainText('pending');
  await page.waitForTimeout(700);

  expect(saveRequests).toBe(0);
});

test('keeps editing active when Done cannot save', async ({ page }) => {
  await page.goto('/save-failure');
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

test('keeps editing active when content changes while Done is saving', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/save-failure');
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
  await page.goto('/save-failure');
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
  await expect(page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Undo' })).toBeFocused();
  await restored.focus();
  await restored.press('Control+s');
  await restored.press('Escape');
  await expect(restored).not.toHaveAttribute('contenteditable', 'true');
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

test('handles duplicate setup, page events, open panels, block switches, and disabling while active', async ({ page }) => {
  await page.goto('/resilience');
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

  await page.getByRole('button', { name: 'Page editor' }).click();
  await page.getByRole('button', { name: 'Edit frontmatter' }).click();
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
  await expect(editor.getByRole('group', { name: 'Edit link' })).not.toBeVisible();

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
  await page.goto('/guards');
  const editor = page.locator('#astro-wysiwyg-toolbar');
  await page.evaluate(() => {
    dispatchEvent(new Event('scroll'));
    const shadow = document.querySelector('#astro-wysiwyg-toolbar')?.shadowRoot;
    shadow?.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
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
  await expect(editor.getByRole('group', { name: 'Edit link' })).not.toBeVisible();
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
  await editor.getByRole('button', { name: 'Link' }).click();
  await editor.getByRole('button', { name: 'Done' }).click();
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
  await page.goto('/guards');
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
    const text = element.firstChild;
    if (!text) throw new Error('Missing text');
    const start = text.textContent?.indexOf('plain') ?? -1;
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
  await page.getByRole('button', { name: 'Page editor' }).click();
  await page.getByRole('button', { name: 'Edit frontmatter' }).click();
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
  await page.getByRole('button', { name: 'Page editor' }).click();
  await page.getByRole('button', { name: 'Edit frontmatter' }).click();
  dialog = page.locator('#astro-wysiwyg-toolbar').getByRole('dialog', { name: 'Edit frontmatter' });
  await expect(dialog.getByRole('alert')).toHaveText('Load failed.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  failRead = false;
  await page.getByRole('button', { name: 'Edit frontmatter' }).click();
  await dialog.getByRole('textbox', { name: 'title' }).fill('Will not save');
  await dialog.getByRole('button', { name: 'Save frontmatter' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Save failed.');
  await dialog.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Page editor' }).click();
  await page.getByRole('button', { name: 'Edit frontmatter' }).click();
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
  await editor.getByRole('button', { name: 'Add block below' }).click();
  await expect(editor.getByRole('status')).toHaveText('Structure failed.');
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Delete block' }).click();
  await expect(first).toHaveAttribute('contenteditable', 'true');
  await first.evaluate((element) => {
    element.textContent = 'First block.';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  });
  await editor.getByRole('button', { name: 'Add block below' }).click();
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
  await page.goto('/detached');
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
  await page.goto('/detached');
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
  const add = page.locator('#astro-wysiwyg-toolbar').getByRole('button', { name: 'Add block below' }).click();
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

  await editor.getByRole('button', { name: 'Add block below' }).click();

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

  await editor.getByRole('button', { name: 'Heading 6' }).click();

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
  await expect.poll(async () => readFile(listFile, 'utf8')).toContain('- Turn this paragraph into a list.');

  await page.waitForTimeout(2_500);
  const list = page.locator('main > ul');
  await expect(list).toHaveAttribute('contenteditable', 'true');
  await editor.getByRole('button', { name: 'Numbered list' }).click();
  await expect.poll(async () => readFile(listFile, 'utf8')).toContain('1. Turn this paragraph into a list.');
});

test('undoes a saved wrapped-paragraph edit after Astro reload without repeat writes', async ({ page }) => {
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

test('updates preferences and toolbar placement through the Astro dev toolbar', async ({ page }) => {
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
  await page.getByRole('checkbox', { name: 'Autosave changes' }).evaluate((element) => (element as HTMLInputElement).click());
  expect(await page.evaluate(() => (window as Window & { preferenceEvents: unknown[] }).preferenceEvents)).toEqual([
    { enabled: true, autosave: false, highlights: true },
  ]);

  await page.getByRole('button', { name: 'Settings' }).click();
  const placement = page.getByRole('combobox');
  await placement.selectOption('bottom-left');
  await page.getByRole('button', { name: 'Page editor' }).click();
  await expect(page.getByRole('heading', { name: 'Page editor' })).toBeVisible();
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
