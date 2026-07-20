import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Window } from 'happy-dom';
import { toolbarMarkup } from '../src/client.ts';

function renderToolbar(): ShadowRoot {
  const window = new Window();
  const host = window.document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = toolbarMarkup();
  return shadow as unknown as ShadowRoot;
}

test('contextual toolbar uses the approved groups, action order, icons, and label policy', () => {
  const shadow = renderToolbar();
  const groups = [...shadow.querySelectorAll<HTMLElement>('.toolbar-group')];
  assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), [
    'History', 'Block type', 'Format', 'Structure', 'Session',
  ]);

  const controls = [...shadow.querySelectorAll<HTMLButtonElement>('[data-toolbar-item]')];
  assert.deepEqual(controls.map((button) => (
    button.dataset.action ?? button.dataset.command ?? button.dataset.list
  )), [
    'undo', 'toggle-text-style', 'bold', 'italic', 'link', 'ul', 'ol',
    'toggle-insert', 'toggle-replace-content', 'replace-image', 'replace-video', 'replace-iframe', 'delete-block', 'save', 'done',
  ]);
  assert.deepEqual(controls.map((button) => button.querySelector('svg')?.getAttribute('data-icon')), [
    'undo-2', 'type', 'bold', 'italic', 'link', 'list', 'list-ordered',
    'plus', 'type', 'image-plus', 'video', 'link', 'trash-2', 'save', 'check',
  ]);

  const iconOnly = controls.filter((button) => button.classList.contains('icon-only'));
  assert.deepEqual(iconOnly.map((button) => button.getAttribute('aria-label')), [
    'Undo', 'Bold', 'Italic', 'Link', 'Bullet list', 'Numbered list',
  ]);
  assert.deepEqual(controls.filter((button) => !button.classList.contains('icon-only')).map((button) => button.textContent?.trim()), [
    'Paragraph', 'Insert', 'Replace block', 'Replace image', 'Replace video', 'Edit iframe', 'Delete', 'Save', 'Done',
  ]);
  for (const icon of shadow.querySelectorAll('svg')) {
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.getAttribute('focusable'), 'false');
  }
  assert.equal(shadow.querySelector('[title]'), null);
  assert.doesNotMatch(controls.map((button) => button.textContent).join(''), /[↶•]/);
});

test('text style, insert, link, state, and tooltip markup expose names and reserved actions', () => {
  const shadow = renderToolbar();
  const styleTrigger = shadow.querySelector<HTMLButtonElement>('[data-action="toggle-text-style"]')!;
  assert.equal(styleTrigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(styleTrigger.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(
    [...shadow.querySelectorAll<HTMLButtonElement>('#text-style-menu [role="menuitem"]')]
      .map((button) => button.textContent?.trim().replace(/\s+/g, ' ')),
    ['Paragraph', 'Heading 1 Alt+1', 'Heading 2 Alt+2', 'Heading 3 Alt+3', 'Heading 4 Alt+4', 'Heading 5 Alt+5', 'Heading 6 Alt+6'],
  );
  assert.equal(shadow.querySelectorAll('.toolbar-groups [data-tag]').length, 0);

  const insertItems = [...shadow.querySelectorAll<HTMLButtonElement>('#insert-menu [role="menuitem"]')];
  assert.deepEqual(insertItems.map((button) => button.textContent?.trim()), [
    'Paragraph below', 'Heading', 'Bulleted list', 'Numbered list', 'Blockquote', 'Code block', 'Divider',
    'Image', 'Video', 'Iframe embed',
  ]);
  assert.deepEqual(insertItems.map((button) => button.querySelector('svg')?.getAttribute('data-icon')), [
    'pilcrow', 'type', 'list', 'list-ordered', 'pilcrow', 'type', 'plus', 'image-plus', 'video', 'link',
  ]);
  assert.ok([...shadow.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .every((button) => button.tabIndex === -1));
  assert.equal(insertItems[0].disabled, false);
  assert.equal(insertItems[1].disabled, false);
  assert.equal(insertItems[1].dataset.action, 'insert-content');
  assert.equal(insertItems[1].dataset.contentType, 'heading');
  assert.equal(insertItems[2].disabled, false);
  assert.equal(insertItems[2].dataset.contentType, 'bulleted-list');
  assert.equal(insertItems[7].dataset.action, 'open-image');
  assert.equal(insertItems[8].dataset.action, 'open-video');
  assert.equal(insertItems[9].dataset.action, 'open-iframe');
  assert.match(shadow.querySelector('#insert-menu .picker-help')?.textContent ?? '', /Dynamic expressions/);
  const replaceItems = [...shadow.querySelectorAll<HTMLButtonElement>('#replace-content-menu [role="menuitem"]')];
  assert.deepEqual(replaceItems.map((button) => button.textContent?.trim()), [
    'Replace with paragraph', 'Replace with heading', 'Replace with bulleted list',
    'Replace with numbered list', 'Replace with blockquote', 'Replace with code block', 'Replace with divider',
  ]);
  assert.ok(replaceItems.every((button) => button.dataset.action === 'replace-content'));

  const imageDialog = shadow.querySelector<HTMLDialogElement>('.image-editor')!;
  assert.equal(imageDialog.getAttribute('aria-label'), 'Insert image');
  assert.equal(imageDialog.querySelector<HTMLInputElement>('input[type="file"]')?.accept, '.png,.jpg,.jpeg,.gif,.webp');
  assert.equal(imageDialog.querySelector<HTMLInputElement>('[name="destination"]')?.required, true);
  assert.equal(imageDialog.querySelector<HTMLInputElement>('[name="alt"]')?.required, true);
  assert.deepEqual(
    [...imageDialog.querySelectorAll<HTMLInputElement>('[name="image-source"]')]
      .map((input) => input.value),
    ['upload', 'existing'],
  );
  assert.equal(imageDialog.querySelector<HTMLInputElement>('[name="existing-reference"]')?.disabled, true);
  assert.ok(imageDialog.querySelector<HTMLImageElement>('[data-image-preview]'));
  assert.deepEqual(
    [...imageDialog.querySelectorAll('button')].map((button) => button.textContent?.trim()),
    ['Upload image', 'Insert image', 'Cancel'],
  );
  assert.equal(imageDialog.querySelector<HTMLButtonElement>('[data-action="insert-image"]')?.disabled, true);
  const replaceImage = shadow.querySelector<HTMLButtonElement>('[data-action="replace-image"]')!;
  assert.equal(replaceImage.hidden, true);
  assert.equal(replaceImage.disabled, true);
  assert.equal(imageDialog.querySelector('[role="alert"]')?.hasAttribute('aria-live'), true);

  const videoDialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
  assert.equal(videoDialog.getAttribute('aria-label'), 'Insert video');
  assert.equal(videoDialog.querySelector<HTMLInputElement>('input[type="file"]')?.accept, '.mp4');
  assert.equal(videoDialog.querySelector<HTMLInputElement>('[name="video-label"]')?.required, true);
  assert.equal(videoDialog.querySelector<HTMLTextAreaElement>('[name="video-description"]')?.required, true);
  assert.equal(videoDialog.querySelector<HTMLInputElement>('[name="video-controls"]')?.checked, true);
  assert.equal(videoDialog.querySelector<HTMLInputElement>('[name="video-controls"]')?.required, true);
  assert.equal(videoDialog.querySelector<HTMLSelectElement>('[name="video-preload"]')?.value, 'metadata');
  assert.deepEqual(
    [...videoDialog.querySelectorAll<HTMLInputElement>('[name="video-source"]')]
      .map((input) => input.value),
    ['upload', 'existing'],
  );
  assert.equal(videoDialog.querySelector<HTMLInputElement>('[name="existing-video-reference"]')?.disabled, true);
  assert.deepEqual(
    [...videoDialog.querySelectorAll('button')].map((button) => button.textContent?.trim()),
    ['Upload video', 'Preview existing video', 'Insert video', 'Cancel'],
  );
  assert.equal(videoDialog.querySelector<HTMLButtonElement>('[data-action="insert-video"]')?.disabled, true);
  const replaceVideo = shadow.querySelector<HTMLButtonElement>('[data-action="replace-video"]')!;
  assert.equal(replaceVideo.hidden, true);
  assert.equal(replaceVideo.disabled, true);
  assert.equal(videoDialog.querySelector('[role="alert"]')?.hasAttribute('aria-live'), true);

  const iframeDialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor')!;
  assert.equal(iframeDialog.getAttribute('aria-label'), 'Insert iframe');
  assert.equal(iframeDialog.querySelector<HTMLInputElement>('[name="iframe-src"]')?.required, true);
  assert.equal(iframeDialog.querySelector<HTMLInputElement>('[name="iframe-title"]')?.required, true);
  assert.equal(iframeDialog.querySelector<HTMLInputElement>('[name="iframe-width"]')?.max, '4096');
  assert.equal(iframeDialog.querySelector<HTMLSelectElement>('[name="iframe-referrer-policy"]')?.value, 'strict-origin-when-cross-origin');
  assert.ok(iframeDialog.querySelector('[data-iframe-preview-container]'));
  assert.equal(iframeDialog.querySelector('[data-iframe-preview]'), null);
  assert.deepEqual(
    [...iframeDialog.querySelectorAll('button')].map((button) => button.textContent?.trim()),
    ['Preview iframe', 'Insert iframe', 'Cancel'],
  );
  assert.equal(iframeDialog.querySelector<HTMLButtonElement>('[data-action="apply-iframe"]')?.disabled, true);
  const replaceIframe = shadow.querySelector<HTMLButtonElement>('[data-action="replace-iframe"]')!;
  assert.equal(replaceIframe.hidden, true);
  assert.equal(replaceIframe.disabled, true);
  assert.equal(iframeDialog.querySelector('[role="alert"]')?.hasAttribute('aria-live'), true);

  const collectionDialog = shadow.querySelector<HTMLDialogElement>('.collection-entry-editor')!;
  assert.equal(collectionDialog.getAttribute('aria-label'), 'Create collection entry');
  assert.equal(collectionDialog.querySelector<HTMLSelectElement>('[name="collection"]')?.required, true);
  assert.equal(collectionDialog.querySelector<HTMLInputElement>('[name="slug"]')?.required, true);
  assert.equal(collectionDialog.querySelector<HTMLInputElement>('[name="slug"]')?.pattern, '[a-z0-9]+(?:-[a-z0-9]+)*');
  assert.equal(collectionDialog.querySelector<HTMLTextAreaElement>('[name="body"]')?.required, true);
  assert.ok(collectionDialog.querySelector('[data-collection-fields]'));
  assert.ok(collectionDialog.querySelector('[data-unsupported-collections]'));
  assert.deepEqual(
    [...collectionDialog.querySelectorAll('button')].map((button) => button.textContent?.trim()),
    ['Create entry', 'Cancel'],
  );
  assert.equal(collectionDialog.querySelector('[role="alert"]')?.hasAttribute('aria-live'), true);

  assert.equal(shadow.querySelector('.link-editor')?.getAttribute('role'), 'dialog');
  assert.equal(shadow.querySelector('.link-editor label')?.textContent?.trim(), 'Link URL');
  assert.equal(shadow.querySelector('[data-command="bold"]')?.getAttribute('aria-pressed'), 'false');
  assert.equal(shadow.querySelector('[data-list="ul"]')?.getAttribute('aria-pressed'), 'false');
  assert.equal(shadow.querySelector('[data-action="link"]')?.getAttribute('aria-expanded'), 'false');
  assert.equal(shadow.querySelector('[role="tooltip"]')?.hasAttribute('hidden'), true);
});

test('selected Lucide assets are local, attributed, and add no runtime icon package', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
    files: string[];
  };
  assert.equal(Object.keys(packageJson.dependencies).some((name) => name.includes('lucide')), false);
  assert.ok(packageJson.files.includes('THIRD_PARTY_NOTICES.md'));
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /Copyright \(c\) 2026 Lucide Icons and Contributors/);
  assert.match(notices, /Copyright \(c\) 2013-present Cole Bemis/);
});
