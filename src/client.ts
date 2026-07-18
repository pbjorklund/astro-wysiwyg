import {
  FRONTMATTER_EVENT,
  PREFERENCES_EVENT,
  type EditorPreferences,
  readPreferences,
} from './preferences.ts';

export interface EditorOptions {
  endpoint: string;
  saveDelay: number;
}

interface SaveResponse {
  marker?: string;
  error?: string;
}

interface FrontmatterFieldResponse {
  name: string;
  type: 'boolean' | 'date' | 'list' | 'number' | 'string';
  value: string | boolean;
}

const MARKER_ATTRIBUTE = 'data-astro-wysiwyg';
const ACTIVE_ATTRIBUTE = 'data-astro-wysiwyg-active';
const BLOCK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'figcaption', 'dt', 'dd', 'td', 'th',
  'caption', 'legend', 'summary', 'button', 'label',
];
const SOURCE_SELECTOR = BLOCK_TAGS
  .map((tag) => `${tag}[data-wysiwyg-source-file][data-wysiwyg-source-loc]`)
  .join(',');
const ASTRO_SOURCE_SELECTOR = BLOCK_TAGS
  .map((tag) => `${tag}[data-astro-source-file][data-astro-source-loc]`)
  .join(',');
const EDITABLE_SELECTOR = `[${MARKER_ATTRIBUTE}],${SOURCE_SELECTOR}`;
const PREPARE_SELECTOR = `${EDITABLE_SELECTOR},${ASTRO_SOURCE_SELECTOR}`;
const HOST_ID = 'astro-wysiwyg-toolbar';
const SESSION_KEY = 'astro-wysiwyg-active';

interface EditSnapshot {
  html: string;
  tag: string;
}

interface ActiveSession {
  pathname: string;
  file?: string;
  start?: number;
  sourceFile?: string;
  sourceLocation?: string;
  href?: string;
  html?: string;
  tag?: string;
  caret?: number;
  history?: EditSnapshot[];
  saving?: boolean;
  suppressAutosave?: boolean;
}

export function startEditor(options: EditorOptions): void {
  if (document.getElementById(HOST_ID)) return;

  let active: HTMLElement | null = null;
  let saveTimer: number | undefined;
  let saveQueue = Promise.resolve();
  let preferences = readPreferences();
  let undoHistory: EditSnapshot[] = [];
  let linkRange: Range | undefined;
  let editingLink: HTMLAnchorElement | undefined;
  let frontmatterContext: string | undefined;
  let frontmatterFields: FrontmatterFieldResponse[] = [];
  let activeSaveInFlight = false;
  let suppressRestoredAutosave = false;
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = toolbarMarkup();
  document.body.append(host);

  const toolbar = shadow.querySelector<HTMLElement>('[role="toolbar"]')!;
  const status = shadow.querySelector<HTMLElement>('[role="status"]')!;

  const globalStyle = document.createElement('style');
  globalStyle.dataset.astroWysiwygStyle = '';
  globalStyle.textContent = `
    html[data-astro-wysiwyg-enabled] :is(${EDITABLE_SELECTOR}) { cursor: text; }
    html[data-astro-wysiwyg-highlights] :is(${EDITABLE_SELECTOR}):hover { outline: 1px dashed Highlight; outline-offset: 3px; }
    html[data-astro-wysiwyg-highlights] :is(${EDITABLE_SELECTOR}):focus-visible,
    [${ACTIVE_ATTRIBUTE}] { outline: 2px solid Highlight !important; outline-offset: 3px; }
  `;
  document.head.append(globalStyle);
  applyPreferences(preferences);

  prepareEditableBlocks(document);
  void restoreActiveSession();
  document.addEventListener('astro:page-load', () => {
    prepareEditableBlocks(document);
    void restoreActiveSession();
  });
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('selectionchange', rememberActiveSession);
  document.addEventListener(PREFERENCES_EVENT, onPreferences);
  document.addEventListener(FRONTMATTER_EVENT, () => void openFrontmatterEditor());
  window.addEventListener('scroll', positionToolbar, true);
  window.addEventListener('resize', positionToolbar);
  shadow.addEventListener('pointerdown', (event) => {
    if (event.target instanceof HTMLButtonElement) event.preventDefault();
  });
  shadow.addEventListener('click', onToolbarClick);
  shadow.addEventListener('keydown', onToolbarKeyDown);

  function onPreferences(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    applyPreferences(event.detail as EditorPreferences);
  }

  function applyPreferences(next: EditorPreferences): void {
    preferences = next;
    document.documentElement.toggleAttribute('data-astro-wysiwyg-enabled', preferences.enabled);
    document.documentElement.toggleAttribute(
      'data-astro-wysiwyg-highlights',
      preferences.enabled && preferences.highlights,
    );
    if (!preferences.enabled) {
      window.clearTimeout(saveTimer);
      if (active) void finishEditing();
      for (const element of document.querySelectorAll<HTMLElement>('[data-wysiwyg-added-tabindex]')) {
        element.removeAttribute('tabindex');
        delete element.dataset.wysiwygAddedTabindex;
      }
      return;
    }
    prepareEditableBlocks(document);
  }

  function prepareEditableBlocks(root: ParentNode): void {
    for (const element of root.querySelectorAll<HTMLElement>(PREPARE_SELECTOR)) {
      const sourceFile = element.getAttribute('data-astro-source-file');
      const sourceLocation = element.getAttribute('data-astro-source-loc');
      if (sourceFile && sourceLocation) {
        element.dataset.wysiwygSourceFile = sourceFile;
        element.dataset.wysiwygSourceLoc = sourceLocation;
      }
      if (preferences.enabled && !element.hasAttribute('tabindex')) {
        element.tabIndex = 0;
        element.dataset.wysiwygAddedTabindex = '';
      }
    }
  }

  function onDocumentClick(event: MouseEvent): void {
    if (!preferences.enabled) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    let block = target.closest<HTMLElement>(EDITABLE_SELECTOR);
    if (block?.localName === 'li') {
      const list = block.parentElement?.closest<HTMLElement>('ul, ol');
      if (list?.matches(EDITABLE_SELECTOR)) block = list;
    }
    if (!block) return;
    if (target.closest('a')) event.preventDefault();
    suppressRestoredAutosave = false;
    void activate(block);
  }

  async function activate(block: HTMLElement): Promise<HTMLElement | undefined> {
    if (!preferences.enabled) return undefined;
    if (!block.hasAttribute(MARKER_ATTRIBUTE) && !await resolveSourceMarker(block)) return undefined;
    if (active === block) return active;
    if (isFrontmatterEditorOpen()) closeFrontmatterEditor();
    if (isLinkEditorOpen()) closeLinkEditor();
    if (active) {
      const previous = active;
      if (hasUnsavedChanges(previous)) queueSave(previous);
      deactivate(previous);
    }
    active = block;
    active.setAttribute('contenteditable', 'true');
    active.setAttribute(ACTIVE_ATTRIBUTE, '');
    undoHistory = [snapshot(active)];
    toolbar.hidden = false;
    updateUndoButton();
    updateStructureButtons();
    setStatus('Editing');
    positionToolbar();
    active.focus({ preventScroll: true });
    rememberActiveSession();
    return active;
  }

  async function restoreActiveSession(): Promise<void> {
    if (active) return;
    const session = readActiveSession();
    if (!session || session.pathname !== location.pathname) return;
    suppressRestoredAutosave = Boolean(session.saving || session.suppressAutosave);
    let block: HTMLElement | undefined;
    if (session.sourceFile && session.sourceLocation) {
      block = [...document.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)]
        .filter((element) => element.dataset.wysiwygSourceFile === session.sourceFile
          && (!session.href || element.closest('a')?.getAttribute('href') === session.href))
        .sort((left, right) => sourceLocationDistance(left.dataset.wysiwygSourceLoc, session.sourceLocation!)
          - sourceLocationDistance(right.dataset.wysiwygSourceLoc, session.sourceLocation!))[0];
    }
    if (!block && session.file) {
      const candidates = [...document.querySelectorAll<HTMLElement>(`[${MARKER_ATTRIBUTE}]`)]
        .map((element) => ({ element, marker: decodeClientMarker(element.getAttribute(MARKER_ATTRIBUTE)) }))
        .filter((candidate) => candidate.marker?.file === session.file)
        .sort((left, right) => Math.abs((left.marker?.start ?? 0) - (session.start ?? 0))
          - Math.abs((right.marker?.start ?? 0) - (session.start ?? 0)));
      block = candidates[0]?.element;
    }
    if (!block) return;
    let restored = await activate(block);
    if (!restored) return;
    if (session.history?.length) undoHistory = session.history;
    if (session.tag && restored.localName !== session.tag) {
      changeBlockTag(session.tag, false, false);
      restored = active ?? restored;
    }
    if (session.html !== undefined && restored.innerHTML !== session.html) {
      restored.innerHTML = session.html;
      if (preferences.autosave && !suppressRestoredAutosave) {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => queueSave(restored), options.saveDelay);
      }
    }
    setCaretOffset(restored, session.caret);
    rememberActiveSession();
    updateUndoButton();
  }

  function rememberActiveSession(): void {
    if (!active) return;
    const marker = decodeClientMarker(active.getAttribute(MARKER_ATTRIBUTE));
    const session: ActiveSession = {
      pathname: location.pathname,
      file: marker?.file,
      start: marker?.start,
      sourceFile: active.dataset.wysiwygSourceFile,
      sourceLocation: active.dataset.wysiwygSourceLoc,
      href: active.closest('a')?.getAttribute('href') ?? undefined,
      html: active.innerHTML,
      tag: active.localName,
      caret: getCaretOffset(active),
      history: undoHistory,
      saving: activeSaveInFlight,
      suppressAutosave: suppressRestoredAutosave,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Editing still works when session storage is unavailable.
    }
  }

  async function resolveSourceMarker(element: HTMLElement): Promise<boolean> {
    const sourceFile = element.dataset.wysiwygSourceFile;
    const sourceLocation = element.dataset.wysiwygSourceLoc;
    if (!sourceFile || !sourceLocation) return false;
    try {
      const contextMarker = document.querySelector<HTMLElement>(`[${MARKER_ATTRIBUTE}]`)
        ?.getAttribute(MARKER_ATTRIBUTE) ?? undefined;
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceFile,
          sourceLocation,
          contextMarker,
          contextHref: element.closest('a')?.getAttribute('href') ?? undefined,
          renderedText: element.textContent?.trim() ?? '',
        }),
      });
      const body = await response.json() as SaveResponse;
      if (!response.ok || !body.marker) return false;
      element.setAttribute(MARKER_ATTRIBUTE, body.marker);
      return true;
    } catch {
      return false;
    }
  }

  function deactivate(element: HTMLElement): void {
    element.removeAttribute('contenteditable');
    element.removeAttribute(ACTIVE_ATTRIBUTE);
  }

  function onInput(event: Event): void {
    if (event.target !== active || !active) return;
    window.clearTimeout(saveTimer);
    suppressRestoredAutosave = false;
    setStatus('Unsaved');
    rememberActiveSession();
    updateUndoButton();
    if (preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
    positionToolbar();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!preferences.enabled) return;
    const target = event.target;
    if (!active && event.key === 'Enter' && target instanceof HTMLElement && target.matches(EDITABLE_SELECTOR)) {
      event.preventDefault();
      void activate(target);
      return;
    }
    if (!active || !active.contains(target as Node)) return;

    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.shiftKey && event.code === 'Digit7') {
      event.preventDefault();
      changeList('ol');
    } else if (modifier && event.shiftKey && event.code === 'Digit8') {
      event.preventDefault();
      changeList('ul');
    } else if (modifier && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openLinkEditor();
    } else if (modifier && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault();
      undoEdit();
    } else if (modifier && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      runInlineCommand('bold');
    } else if (modifier && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      runInlineCommand('italic');
    } else if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      queueSave(active);
    } else if (event.altKey && event.key === 'F10') {
      event.preventDefault();
      toolbar.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    } else if (event.altKey && /^Digit[1-6]$/.test(event.code)) {
      event.preventDefault();
      changeBlockTag(`h${event.code.slice(-1)}`);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void finishEditing();
    }
  }

  function onToolbarKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === 'Enter'
      && event.target instanceof HTMLInputElement
      && event.target.closest('.link-editor')) {
      event.preventDefault();
      applyLink();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (isFrontmatterEditorOpen()) closeFrontmatterEditor();
    else if (isLinkEditorOpen()) closeLinkEditor();
    else void finishEditing();
  }

  function onToolbarClick(event: Event): void {
    const button = event.composedPath().find(
      (item): item is HTMLButtonElement => item instanceof HTMLButtonElement,
    );
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'save-frontmatter') {
      void saveFrontmatter();
      return;
    }
    if (action === 'cancel-frontmatter') {
      closeFrontmatterEditor();
      return;
    }
    if (!active) return;
    const command = button.dataset.command;
    const tag = button.dataset.tag;
    const list = button.dataset.list;
    if (command) runInlineCommand(command);
    else if (tag) changeBlockTag(tag);
    else if (list === 'ul' || list === 'ol') changeList(list);
    else if (button.dataset.action === 'undo') undoEdit();
    else if (button.dataset.action === 'add-block') void addBlockAfter();
    else if (button.dataset.action === 'delete-block') void deleteBlock();
    else if (button.dataset.action === 'link') openLinkEditor();
    else if (button.dataset.action === 'apply-link') applyLink();
    else if (button.dataset.action === 'remove-link') removeLink();
    else if (button.dataset.action === 'cancel-link') closeLinkEditor();
    else if (button.dataset.action === 'save') queueSave(active);
    else if (button.dataset.action === 'done') void finishEditing();
  }

  async function structuralTarget(): Promise<{ element: HTMLElement; marker: string } | undefined> {
    if (!active) return undefined;
    let element = active;
    if (hasUnsavedChanges(element)) {
      const saved = await queueSave(element);
      if (!saved) return undefined;
      element = active ?? element;
    }
    const marker = element.getAttribute(MARKER_ATTRIBUTE);
    const decoded = decodeClientMarker(marker);
    if (!marker || !decoded || decoded.format === 'frontmatter') {
      setStatus('Frontmatter fields cannot be added or deleted.', true);
      return undefined;
    }
    return { element, marker };
  }

  async function addBlockAfter(): Promise<void> {
    const target = await structuralTarget();
    if (!target) return;
    setStatus('Adding block...');
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marker: target.marker, operation: 'insert-after' }),
      });
      const body = await response.json() as SaveResponse;
      if (!response.ok || !body.marker) throw new Error(body.error ?? 'The block could not be added.');

      const paragraph = document.createElement('p');
      paragraph.textContent = 'New paragraph';
      paragraph.setAttribute(MARKER_ATTRIBUTE, body.marker);
      if (target.element.isConnected) {
        target.element.after(paragraph);
        await activate(paragraph);
      } else {
        rememberInsertedBlock(body.marker);
        active = null;
        await restoreActiveSession();
      }
      setStatus('Block added');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The block could not be added.', true);
    }
  }

  async function deleteBlock(): Promise<void> {
    if (!active || !window.confirm('Delete this block from its source file?')) return;
    const target = await structuralTarget();
    if (!target) return;
    setStatus('Deleting block...');
    try {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
        // Deletion still works when session storage is unavailable.
      }
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marker: target.marker, operation: 'delete' }),
      });
      const body = await response.json() as SaveResponse;
      if (!response.ok) throw new Error(body.error ?? 'The block could not be deleted.');
      if (target.element.isConnected) target.element.remove();
      active = null;
      undoHistory = [];
      toolbar.hidden = true;
      setStatus('Block deleted');
    } catch (error) {
      if (target.element.isConnected) {
        active = target.element;
        rememberActiveSession();
      }
      setStatus(error instanceof Error ? error.message : 'The block could not be deleted.', true);
    }
  }

  function rememberInsertedBlock(token: string): void {
    const marker = decodeClientMarker(token);
    if (!marker) return;
    const inserted = { html: 'New paragraph', tag: 'p' };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        pathname: location.pathname,
        file: marker.file,
        start: marker.start,
        html: inserted.html,
        tag: inserted.tag,
        history: [inserted],
        suppressAutosave: true,
      } satisfies ActiveSession));
    } catch {
      // The inserted block still exists in source when session storage is unavailable.
    }
  }

  function updateStructureButtons(): void {
    const marker = decodeClientMarker(active?.getAttribute(MARKER_ATTRIBUTE) ?? null);
    const disabled = !marker || marker.format === 'frontmatter';
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>(
      '[data-action="add-block"], [data-action="delete-block"]',
    )) {
      button.disabled = disabled;
    }
  }

  function findFrontmatterContextMarker(): string | undefined {
    const candidates = [
      active,
      ...document.querySelectorAll<HTMLElement>(`[${MARKER_ATTRIBUTE}]`),
    ];
    for (const element of candidates) {
      const token = element?.getAttribute(MARKER_ATTRIBUTE);
      const marker = decodeClientMarker(token ?? null);
      if (token && marker && /\.(?:md|mdx|mdoc)$/i.test(marker.file)) return token;
    }
    return undefined;
  }

  function isFrontmatterEditorOpen(): boolean {
    return shadow.querySelector<HTMLDialogElement>('.frontmatter-editor')?.open ?? false;
  }

  async function openFrontmatterEditor(): Promise<void> {
    if (isLinkEditorOpen()) closeLinkEditor();
    const marker = findFrontmatterContextMarker();
    const editor = shadow.querySelector<HTMLDialogElement>('.frontmatter-editor');
    const fields = shadow.querySelector<HTMLElement>('.frontmatter-fields');
    if (!editor || !fields) return;
    frontmatterContext = marker;
    frontmatterFields = [];
    if (!editor.open) editor.showModal();
    fields.replaceChildren();
    setFrontmatterMessage('Loading...');

    if (!marker) {
      setFrontmatterMessage('Open a Markdown or MDX page with source-backed content.');
      return;
    }

    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter: 'read', contextMarker: marker }),
      });
      const body = await response.json() as { fields?: FrontmatterFieldResponse[]; error?: string };
      if (!response.ok || !body.fields) throw new Error(body.error ?? 'Frontmatter could not be loaded.');
      frontmatterFields = body.fields;
      renderFrontmatterFields(fields, frontmatterFields);
      setFrontmatterMessage(frontmatterFields.length ? '' : 'No simple frontmatter fields were found.');
      fields.querySelector<HTMLInputElement>('input')?.focus();
    } catch (error) {
      setFrontmatterMessage(error instanceof Error ? error.message : 'Frontmatter could not be loaded.');
    }
  }

  function renderFrontmatterFields(container: HTMLElement, fields: FrontmatterFieldResponse[]): void {
    for (const field of fields) {
      const label = document.createElement('label');
      label.className = 'frontmatter-field';
      const name = document.createElement('span');
      name.textContent = field.name;
      const input = document.createElement('input');
      input.dataset.frontmatterField = field.name;
      input.setAttribute('aria-label', field.name);
      if (field.type === 'boolean') {
        input.type = 'checkbox';
        input.checked = field.value === true;
      } else {
        input.type = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text';
        input.value = String(field.value);
      }
      label.append(name, input);
      container.append(label);
    }
  }

  async function saveFrontmatter(): Promise<void> {
    if (!frontmatterContext) return;
    const values: Record<string, string | boolean> = {};
    for (const field of frontmatterFields) {
      const input = shadow.querySelector<HTMLInputElement>(
        `[data-frontmatter-field="${CSS.escape(field.name)}"]`,
      );
      if (!input) continue;
      const value = field.type === 'boolean' ? input.checked : input.value;
      if (value !== field.value) values[field.name] = value;
    }
    if (Object.keys(values).length === 0) {
      closeFrontmatterEditor();
      return;
    }

    setFrontmatterMessage('Saving...');
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frontmatter: 'update',
          contextMarker: frontmatterContext,
          values,
        }),
      });
      const body = await response.json() as { saved?: boolean; error?: string };
      if (!response.ok || !body.saved) throw new Error(body.error ?? 'Frontmatter could not be saved.');
      setStatus('Saved');
      closeFrontmatterEditor();
    } catch (error) {
      setFrontmatterMessage(error instanceof Error ? error.message : 'Frontmatter could not be saved.');
    }
  }

  function closeFrontmatterEditor(): void {
    const editor = shadow.querySelector<HTMLDialogElement>('.frontmatter-editor');
    if (editor?.open) editor.close();
    frontmatterContext = undefined;
    frontmatterFields = [];
    setFrontmatterMessage('');
    active?.focus({ preventScroll: true });
  }

  function setFrontmatterMessage(message: string): void {
    const element = shadow.querySelector<HTMLElement>('.frontmatter-message');
    if (element) element.textContent = message;
  }

  function isLinkEditorOpen(): boolean {
    const editor = toolbar.querySelector<HTMLElement>('.link-editor');
    return Boolean(editor && !editor.hidden);
  }

  function openLinkEditor(): void {
    if (!active) return;
    const selection = getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (!range || !active.contains(range.commonAncestorContainer)) {
      setLinkError('Select text or place the caret inside a link.');
      return;
    }
    linkRange = range.cloneRange();
    const container = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    editingLink = container?.closest<HTMLAnchorElement>('a') ?? undefined;
    if (editingLink && !active.contains(editingLink)) editingLink = undefined;

    const editor = toolbar.querySelector<HTMLElement>('.link-editor');
    const input = toolbar.querySelector<HTMLInputElement>('.link-editor input');
    const remove = toolbar.querySelector<HTMLButtonElement>('[data-action="remove-link"]');
    if (!editor || !input || !remove) return;
    editor.hidden = false;
    input.value = editingLink?.getAttribute('href') ?? '';
    remove.disabled = !editingLink;
    setLinkError('');
    positionToolbar();
    input.focus();
    input.select();
  }

  function applyLink(): void {
    if (!active || !linkRange) return;
    const input = toolbar.querySelector<HTMLInputElement>('.link-editor input');
    if (!input) return;
    const href = validHref(input.value);
    if (!href) {
      setLinkError('Enter an http, https, mail, phone, anchor, or relative URL.');
      return;
    }
    if (!editingLink && linkRange.collapsed) {
      setLinkError('Select text before adding a new link.');
      return;
    }

    checkpoint(active);
    if (editingLink?.isConnected && active.contains(editingLink)) {
      editingLink.setAttribute('href', href);
    } else {
      restoreLinkRange();
      document.execCommand('createLink', false, href);
    }
    finishLinkChange();
  }

  function removeLink(): void {
    if (!active || !editingLink?.isConnected || !active.contains(editingLink)) return;
    checkpoint(active);
    editingLink.replaceWith(...editingLink.childNodes);
    finishLinkChange();
  }

  function finishLinkChange(): void {
    if (!active) return;
    closeLinkEditor();
    setStatus('Unsaved');
    rememberActiveSession();
    updateUndoButton();
    window.clearTimeout(saveTimer);
    if (preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
  }

  function closeLinkEditor(): void {
    const editor = toolbar.querySelector<HTMLElement>('.link-editor');
    if (editor) editor.hidden = true;
    linkRange = undefined;
    editingLink = undefined;
    setLinkError('');
    active?.focus({ preventScroll: true });
    positionToolbar();
  }

  function restoreLinkRange(): void {
    if (!linkRange) return;
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(linkRange);
  }

  function setLinkError(message: string): void {
    const error = toolbar.querySelector<HTMLElement>('.link-error');
    if (error) error.textContent = message;
  }

  function validHref(value: string): string | undefined {
    const href = value.trim();
    if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
    try {
      const protocol = new URL(href, location.href).protocol;
      return ['http:', 'https:', 'mailto:', 'tel:'].includes(protocol) ? href : undefined;
    } catch {
      return undefined;
    }
  }

  function snapshot(element: HTMLElement): EditSnapshot {
    return { html: element.innerHTML, tag: element.localName };
  }

  function sameSnapshot(left: EditSnapshot, right: EditSnapshot): boolean {
    return left.html === right.html && left.tag === right.tag;
  }

  function checkpoint(element: HTMLElement, value = snapshot(element)): void {
    const previous = undoHistory.at(-1);
    if (!previous || !sameSnapshot(previous, value)) undoHistory.push(value);
    rememberActiveSession();
    updateUndoButton();
  }

  function hasUnsavedChanges(element: HTMLElement): boolean {
    const saved = undoHistory.at(-1);
    return !saved || !sameSnapshot(saved, snapshot(element));
  }

  function updateUndoButton(): void {
    const button = toolbar.querySelector<HTMLButtonElement>('[data-action="undo"]');
    if (!button) return;
    const current = active ? snapshot(active) : undefined;
    button.disabled = !current || (undoHistory.length === 1 && sameSnapshot(undoHistory[0], current));
  }

  function undoEdit(): void {
    if (!active || undoHistory.length === 0) return;
    const current = snapshot(active);
    if (undoHistory.length > 1 && sameSnapshot(undoHistory.at(-1)!, current)) undoHistory.pop();
    const target = undoHistory.at(-1);
    if (!target || sameSnapshot(target, current)) return;
    if (active.localName !== target.tag) changeBlockTag(target.tag, false, false);
    if (!active) return;
    active.innerHTML = target.html;
    active.focus({ preventScroll: true });
    setCaretOffset(active);
    setStatus('Unsaved');
    rememberActiveSession();
    updateUndoButton();
    queueSave(active);
  }

  function runInlineCommand(command: string): void {
    if (!active) return;
    checkpoint(active);
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false);
    active.focus({ preventScroll: true });
    setStatus('Unsaved');
    window.clearTimeout(saveTimer);
    rememberActiveSession();
    updateUndoButton();
    if (preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
  }

  function changeList(tag: 'ul' | 'ol'): void {
    if (!active) return;
    if (active.localName === 'ul' || active.localName === 'ol') {
      if (active.localName !== tag) {
        changeBlockTag(tag);
        return;
      }
      checkpoint(active);
      const paragraph = document.createElement('p');
      const items = [...active.children].filter((child): child is HTMLLIElement => child instanceof HTMLLIElement);
      items.forEach((item, index) => {
        if (index > 0) paragraph.append(document.createElement('br'));
        while (item.firstChild) paragraph.append(item.firstChild);
      });
      replaceActiveElement(paragraph);
      return;
    }

    checkpoint(active);
    const list = document.createElement(tag);
    const item = document.createElement('li');
    while (active.firstChild) item.append(active.firstChild);
    list.append(item);
    replaceActiveElement(list);
  }

  function changeBlockTag(tag: string, record = true, scheduleSave = true): void {
    if (!active || active.localName === tag) return;
    if (record) checkpoint(active);
    const replacement = document.createElement(tag);
    while (active.firstChild) replacement.append(active.firstChild);
    replaceActiveElement(replacement, scheduleSave);
  }

  function replaceActiveElement(replacement: HTMLElement, scheduleSave = true): void {
    if (!active) return;
    for (const attribute of active.attributes) replacement.setAttribute(attribute.name, attribute.value);
    active.replaceWith(replacement);
    active = replacement;
    active.setAttribute('contenteditable', 'true');
    active.focus({ preventScroll: true });
    setStatus('Unsaved');
    window.clearTimeout(saveTimer);
    rememberActiveSession();
    updateUndoButton();
    if (scheduleSave && preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
    positionToolbar();
  }

  async function finishEditing(): Promise<void> {
    if (!active) return;
    if (isFrontmatterEditorOpen()) closeFrontmatterEditor();
    if (isLinkEditorOpen()) closeLinkEditor();
    window.clearTimeout(saveTimer);
    const finished = active;
    if (hasUnsavedChanges(finished)) {
      const saved = await queueSave(finished);
      if (!saved || active !== finished) return;
      if (hasUnsavedChanges(finished)) {
        setStatus('Unsaved');
        return;
      }
    }
    deactivate(finished);
    active = null;
    undoHistory = [];
    updateUndoButton();
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing needs clearing when session storage is unavailable.
    }
    toolbar.hidden = true;
    finished.focus({ preventScroll: true });
    setStatus('Saved');
  }

  function queueSave(element: HTMLElement): Promise<boolean> {
    window.clearTimeout(saveTimer);
    if (element === active) {
      activeSaveInFlight = true;
      suppressRestoredAutosave = false;
      rememberActiveSession();
    }
    const html = element.innerHTML;
    const text = element.textContent ?? '';
    const tag = element.localName;
    setStatus('Saving...');
    const save = saveQueue.then(async () => {
      const marker = element.getAttribute(MARKER_ATTRIBUTE);
      if (!marker) {
        if (element === active) {
          activeSaveInFlight = false;
          rememberActiveSession();
        }
        return false;
      }
      setStatus('Saving...');
      try {
        const response = await fetch(options.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marker, html, text, tag }),
        });
        const body = await response.json() as SaveResponse;
        if (!response.ok || !body.marker) throw new Error(body.error ?? 'The source file could not be saved.');
        if (element.getAttribute(MARKER_ATTRIBUTE) === marker) {
          element.setAttribute(MARKER_ATTRIBUTE, body.marker);
        }
        if (element === active) {
          activeSaveInFlight = false;
          suppressRestoredAutosave = sameSnapshot(snapshot(element), { html, tag });
          checkpoint(element, { html, tag });
        }
        setStatus('Saved');
        return true;
      } catch (error) {
        if (element === active) {
          activeSaveInFlight = false;
          rememberActiveSession();
        }
        setStatus(error instanceof Error ? error.message : 'The source file could not be saved.', true);
        return false;
      }
    });
    saveQueue = save.then(() => undefined);
    return save;
  }

  function positionToolbar(): void {
    if (!active || toolbar.hidden) return;
    const rect = active.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const top = rect.top >= toolbarRect.height + 16
      ? rect.top - toolbarRect.height - 8
      : Math.min(window.innerHeight - toolbarRect.height - 8, rect.bottom + 8);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - toolbarRect.width - 8));
    toolbar.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(8, top))}px)`;
  }

  function setStatus(message: string, error = false): void {
    status.textContent = message;
    status.dataset.error = String(error);
  }
}

function sourceLocationDistance(candidate: string | undefined, target: string): number {
  const parse = (value: string | undefined) => value?.split(':').map(Number) ?? [];
  const [candidateLine, candidateColumn] = parse(candidate);
  const [targetLine, targetColumn] = parse(target);
  if (![candidateLine, candidateColumn, targetLine, targetColumn].every(Number.isFinite)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.abs(candidateLine - targetLine) * 10_000 + Math.abs(candidateColumn - targetColumn);
}

function readActiveSession(): ActiveSession | undefined {
  try {
    const value = sessionStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) as ActiveSession : undefined;
  } catch {
    return undefined;
  }
}

function decodeClientMarker(token: string | null): {
  file: string;
  start: number;
  format: 'astro' | 'frontmatter' | 'markdown';
} | undefined {
  if (!token) return undefined;
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof value.file !== 'string' || typeof value.start !== 'number') return undefined;
    if (value.format !== 'astro' && value.format !== 'frontmatter' && value.format !== 'markdown') return undefined;
    return { file: value.file, start: value.start, format: value.format };
  } catch {
    return undefined;
  }
}

function getCaretOffset(element: HTMLElement): number | undefined {
  const selection = getSelection();
  if (!selection?.focusNode || !element.contains(selection.focusNode)) return undefined;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(selection.focusNode, selection.focusOffset);
  return range.toString().length;
}

function setCaretOffset(element: HTMLElement, offset = element.textContent?.length ?? 0): void {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  element.focus({ preventScroll: true });
}

function toolbarMarkup(): string {
  return `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      [role="toolbar"] {
        position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 3px;
        max-width: calc(100vw - 16px); padding: 6px; overflow-x: auto; pointer-events: auto;
        color: #f8fafc; background: #111827; border: 1px solid #475569; border-radius: 8px;
        box-shadow: 0 6px 24px rgb(0 0 0 / 35%); font: 13px/1.2 ui-sans-serif, system-ui, sans-serif;
      }
      button { min-width: 36px; min-height: 36px; padding: 6px 9px; color: inherit; background: #1f2937; border: 1px solid #64748b; border-radius: 5px; font: inherit; cursor: pointer; }
      button:hover { background: #334155; }
      button.danger { color: #fecaca; border-color: #b91c1c; }
      button.danger:hover { background: #7f1d1d; }
      button:disabled { opacity: .45; cursor: not-allowed; }
      button:focus-visible, input:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 1px; }
      .bold { font-weight: 700; } .italic { font-style: italic; }
      .link-editor { display: flex; align-items: center; gap: 4px; }
      .link-editor input { width: min(260px, 42vw); min-height: 34px; padding: 0 8px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .link-error { max-width: 220px; color: #fecaca; font-size: 12px; }
      .frontmatter-editor { width: min(420px, calc(100vw - 32px)); max-height: min(620px, calc(100vh - 32px)); padding: 16px; overflow-y: auto; color: #f8fafc; background: #111827; border: 1px solid #475569; border-radius: 8px; box-shadow: 0 8px 28px rgb(0 0 0 / 45%); pointer-events: auto; }
      .frontmatter-editor::backdrop { background: rgb(15 23 42 / 65%); }
      .frontmatter-editor h2 { margin: 0 0 12px; font: 600 17px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .frontmatter-fields { display: grid; gap: 9px; }
      .frontmatter-field { display: grid; grid-template-columns: minmax(110px, .7fr) minmax(0, 1.3fr); align-items: center; gap: 10px; }
      .frontmatter-field > span { overflow-wrap: anywhere; color: #cbd5e1; }
      .frontmatter-field input:not([type="checkbox"]) { min-width: 0; min-height: 34px; padding: 0 8px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .frontmatter-field input[type="checkbox"] { width: 20px; height: 20px; }
      .frontmatter-actions { display: flex; align-items: center; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #475569; }
      .frontmatter-message { color: #fecaca; font-size: 12px; }
      .separator { width: 1px; height: 28px; margin: 0 2px; background: #64748b; }
      [role="status"] { min-width: 54px; margin-inline: 5px; white-space: nowrap; color: #bbf7d0; }
      [role="status"][data-error="true"] { max-width: 260px; color: #fecaca; white-space: normal; }
      [hidden] { display: none; }
      @media (forced-colors: active) { [role="toolbar"], button { border: 1px solid ButtonText; } }
    </style>
    <div role="toolbar" aria-label="Edit text" hidden>
      <button type="button" data-action="undo" aria-label="Undo" title="Undo (Ctrl+Z)" disabled>↶</button>
      <span class="separator" aria-hidden="true"></span>
      <button type="button" class="bold" data-command="bold" aria-label="Bold" title="Bold (Ctrl+B)">B</button>
      <button type="button" class="italic" data-command="italic" aria-label="Italic" title="Italic (Ctrl+I)">I</button>
      <button type="button" data-action="link" aria-label="Link" title="Link (Ctrl+K)">Link</button>
      <button type="button" data-list="ul" aria-label="Bullet list" title="Bullet list (Ctrl+Shift+8)">• List</button>
      <button type="button" data-list="ol" aria-label="Numbered list" title="Numbered list (Ctrl+Shift+7)">1. List</button>
      <span class="separator" aria-hidden="true"></span>
      <button type="button" data-action="add-block" aria-label="Add block below">+ Block</button>
      <button type="button" class="danger" data-action="delete-block" aria-label="Delete block">Delete</button>
      <span class="link-editor" role="group" aria-label="Edit link" hidden>
        <label><input type="text" inputmode="url" aria-label="Link URL" placeholder="https://example.com or /page" /></label>
        <button type="button" data-action="apply-link" aria-label="Apply link">Apply</button>
        <button type="button" data-action="remove-link" aria-label="Remove link">Remove</button>
        <button type="button" data-action="cancel-link" aria-label="Cancel link">Cancel</button>
        <span class="link-error" role="alert"></span>
      </span>
      <span class="separator" aria-hidden="true"></span>
      <button type="button" data-tag="h1" aria-label="Heading 1" title="Heading 1 (Alt+1)">H1</button>
      <button type="button" data-tag="h2" aria-label="Heading 2" title="Heading 2 (Alt+2)">H2</button>
      <button type="button" data-tag="h3" aria-label="Heading 3" title="Heading 3 (Alt+3)">H3</button>
      <button type="button" data-tag="h4" aria-label="Heading 4" title="Heading 4 (Alt+4)">H4</button>
      <button type="button" data-tag="h5" aria-label="Heading 5" title="Heading 5 (Alt+5)">H5</button>
      <button type="button" data-tag="h6" aria-label="Heading 6" title="Heading 6 (Alt+6)">H6</button>
      <button type="button" data-tag="p" aria-label="Paragraph">P</button>
      <span class="separator" aria-hidden="true"></span>
      <button type="button" data-action="save">Save</button>
      <button type="button" data-action="done">Done</button>
      <span role="status" aria-live="polite">Editing</span>
    </div>
    <dialog class="frontmatter-editor" aria-label="Edit frontmatter">
      <h2>Frontmatter</h2>
      <div class="frontmatter-fields"></div>
      <div class="frontmatter-actions">
        <button type="button" data-action="save-frontmatter">Save frontmatter</button>
        <button type="button" data-action="cancel-frontmatter">Cancel</button>
        <span class="frontmatter-message" role="alert"></span>
      </div>
    </dialog>
  `;
}
