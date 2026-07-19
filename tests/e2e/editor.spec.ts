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
    changes: { title: { value: 'Editor title', original: 'Markdown fixture' } },
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
    title: { value: 'Recovered frontmatter', original: 'Markdown fixture' },
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
  await title.fill('Markdown fixture');
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
      changes: { title: { original: 'Markdown fixture', value: true } },
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

test('coalesces queued snapshots to the latest edit while a save is in flight', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/queue');
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
  await changeTo('Second snapshot');
  await changeTo('Third snapshot');
  await changeTo('Latest snapshot');
  releaseResponse();
  await page.waitForTimeout(300);

  expect(requests.map(({ html }) => html)).toEqual(['First snapshot', 'Latest snapshot']);
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

test('does not repeat an in-flight save already reflected after reload', async ({ page }) => {
  await page.goto('/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await page.evaluate(() => {
    const key = 'astro-wysiwyg-active';
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    value.sourceOriginal = 'Source before the committed save';
    value.saving = true;
    sessionStorage.setItem(key, JSON.stringify(value));
  });
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unexpected repeat save.' }),
    });
  });

  await page.reload();
  await expect(paragraph).toHaveAttribute('contenteditable', 'true');
  await page.waitForTimeout(700);

  expect(saveRequests).toBe(0);
});

test('retries an in-flight save when its original source is unchanged after reload', async ({ page }) => {
  await page.goto('/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  const token = await paragraph.getAttribute('data-astro-wysiwyg');
  const sourceOriginal = JSON.parse(Buffer.from(token!, 'base64url').toString('utf8')).original;
  const storedSourceOriginal = await page.evaluate(() => {
    const value = JSON.parse(sessionStorage.getItem('astro-wysiwyg-active') ?? '{}');
    return value.sourceOriginal;
  });
  expect(storedSourceOriginal).toBe(sourceOriginal);
  await page.evaluate(() => {
    const key = 'astro-wysiwyg-active';
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    value.html = `${value.html} <em>pending</em>`;
    value.saving = true;
    sessionStorage.setItem(key, JSON.stringify(value));
  });
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Restored save retried.' }),
    });
  });

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
  await page.goto('/pending');
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
  await page.goto('/pending');
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
  await page.goto('/pending');
  const paragraph = page.locator('main > p');
  await paragraph.click();
  await page.evaluate(() => {
    const key = 'astro-wysiwyg-active';
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    value.sourceOriginal = 'Source before an external change';
    value.html = `${value.html} <em>pending</em>`;
    value.saving = true;
    sessionStorage.setItem(key, JSON.stringify(value));
  });
  let saveRequests = 0;
  await page.route('**/_astro-wysiwyg/save', (route) => {
    saveRequests += 1;
    return route.abort();
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

test('times out a stalled save without blocking the next attempt', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/save-failure');
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

test('keeps the previous block recoverable when switching blocks cannot save', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('astro-wysiwyg-preferences', JSON.stringify({
      enabled: true, autosave: false, highlights: true,
    }));
  });
  await page.goto('/guards');
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
  expect(await page.evaluate(() => sessionStorage.getItem('astro-wysiwyg-frontmatter-draft'))).toBeNull();
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
