import { EDITABLE_BLOCK_TAGS } from './editable-tags.ts';
import {
  CONTENT_BLOCK_TYPES,
  CONTENT_PICKER_ITEMS,
  contentBlockType,
  contentBlockTypeFromTag,
  normalizeContentBlockValue,
  replacementWarning,
  type ContentBlockId,
  type ContentBlockValue,
} from './content-blocks.ts';
import { imageUploadEndpoint, suggestImageFilename } from './image-rules.ts';
import { lucideIcon } from './lucide-icons.ts';
import { VIDEO_ACCEPT, suggestVideoFilename, videoUploadEndpoint } from './video-rules.ts';
import {
  CREATE_COLLECTION_ENTRY_EVENT,
  FRONTMATTER_EVENT,
  PREFERENCES_EVENT,
  type EditorPreferences,
  readPreferences,
} from './preferences.ts';

export interface EditorOptions {
  endpoint: string;
  saveDelay: number;
  iframeOrigins?: string[];
}

interface SaveResponse {
  marker?: string;
  error?: string;
}

interface MediaUploadResponse {
  error?: string;
  uploaded?: boolean;
  url?: string;
}

interface FrontmatterFieldResponse {
  name: string;
  type: 'boolean' | 'date' | 'list' | 'number' | 'string';
  value: string | boolean;
  original: string;
}

interface FrontmatterChangeRequest {
  value: string | boolean;
  original: string;
}

interface CollectionFieldResponse {
  name: string;
  type: 'boolean' | 'date' | 'list' | 'number' | 'string';
  required: boolean;
  defaultValue?: string | boolean;
}

interface WritableCollectionResponse {
  name: string;
  directory: string;
  extension: '.md' | '.mdx';
  entryStyle: 'flat' | 'index';
  fields: CollectionFieldResponse[];
  routePattern?: string;
  omittedFields?: Array<{ name: string; reason: string }>;
}

interface CollectionDiscoveryResponse {
  collections?: WritableCollectionResponse[];
  unsupported?: Array<{ name: string; reason: string }>;
  error?: string;
}

interface CollectionCreateResponse {
  created?: boolean;
  collection?: string;
  slug?: string;
  file?: string;
  route?: string;
  routeGuidance?: string;
  error?: string;
}

const MARKER_ATTRIBUTE = 'data-astro-wysiwyg';
const ACTIVE_ATTRIBUTE = 'data-astro-wysiwyg-active';
const NATIVE_ACTION_TAGS = new Set(['button', 'label', 'summary']);
const SOURCE_SELECTOR = [
  ...EDITABLE_BLOCK_TAGS.map((tag) => `${tag}[data-wysiwyg-source-file][data-wysiwyg-source-loc]`),
  'figure[data-wysiwyg-source-file][data-wysiwyg-source-loc]',
  'iframe[data-wysiwyg-source-file][data-wysiwyg-source-loc]',
  'span[data-wysiwyg-source-file][data-wysiwyg-source-loc]',
].join(',');
const ASTRO_SOURCE_SELECTOR = [
  ...EDITABLE_BLOCK_TAGS.map((tag) => `${tag}[data-astro-source-file][data-astro-source-loc]`),
  'figure[data-astro-source-file][data-astro-source-loc]',
  'iframe[data-astro-source-file][data-astro-source-loc]',
  'span[data-astro-source-file][data-astro-source-loc]',
].join(',');
const EDITABLE_SELECTOR = `[${MARKER_ATTRIBUTE}],${SOURCE_SELECTOR}`;
const PREPARE_SELECTOR = `${EDITABLE_SELECTOR},${ASTRO_SOURCE_SELECTOR}`;
const HOST_ID = 'astro-wysiwyg-toolbar';
const EDIT_INSTRUCTIONS_ID = 'astro-wysiwyg-edit-instructions';
const PERSIST_ATTRIBUTE = 'data-astro-transition-persist';
const STYLE_PERSIST_KEY = 'astro-wysiwyg-style';
const SAVE_REQUEST_TIMEOUT = 10_000;
const SESSION_KEY = 'astro-wysiwyg-active';
const FRONTMATTER_DRAFT_KEY = 'astro-wysiwyg-frontmatter-draft';

interface EditSnapshot {
  html: string;
  tag: string;
}

interface QueuedSave extends EditSnapshot {
  element: HTMLElement;
  promise: Promise<boolean>;
  resolve(saved: boolean): void;
  text: string;
}

interface FrontmatterDraft {
  pathname: string;
  contextMarker: string;
  changes: Record<string, FrontmatterChangeRequest>;
}

type ContentUndo =
  | { kind: 'delete' }
  | { kind: 'replace'; type: ContentBlockId; value: ContentBlockValue; html: string; headingLevel?: number; codeLanguage?: string };

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
  dirty?: boolean;
  saving?: boolean;
  suppressAutosave?: boolean;
  sourceOriginal?: string;
  contentUndo?: ContentUndo;
}

export function startEditor(options: EditorOptions): void {
  if (document.getElementById(HOST_ID)) return;

  let active: HTMLElement | null = null;
  let saveTimer: number | undefined;
  const pendingSaves: QueuedSave[] = [];
  let saveInFlight = false;
  let preferences = readPreferences();
  let undoHistory: EditSnapshot[] = [];
  let linkRange: Range | undefined;
  let editingLink: HTMLAnchorElement | undefined;
  let frontmatterContext: string | undefined;
  let frontmatterFields: FrontmatterFieldResponse[] = [];
  let writableCollections: WritableCollectionResponse[] = [];
  let activeSaveInFlight = false;
  let suppressRestoredAutosave = false;
  let lastToolbarControl: HTMLButtonElement | undefined;
  let dismissedTooltip: HTMLButtonElement | undefined;
  let imagePreviewObjectUrl: string | undefined;
  let videoPreviewObjectUrl: string | undefined;
  let contentUndo: ContentUndo | undefined;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute(PERSIST_ATTRIBUTE, HOST_ID);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = toolbarMarkup();
  const editInstructions = document.createElement('span');
  editInstructions.id = EDIT_INSTRUCTIONS_ID;
  editInstructions.setAttribute(PERSIST_ATTRIBUTE, EDIT_INSTRUCTIONS_ID);
  editInstructions.hidden = true;
  editInstructions.textContent = 'Editable source content. Press Enter to edit. Press Alt+Up or Alt+Down to move between editable blocks.';
  document.body.append(host, editInstructions);

  const toolbar = shadow.querySelector<HTMLElement>('[role="toolbar"]')!;
  const status = shadow.querySelector<HTMLElement>('[role="status"]')!;

  const globalStyle = document.createElement('style');
  globalStyle.dataset.astroWysiwygStyle = '';
  globalStyle.setAttribute(PERSIST_ATTRIBUTE, STYLE_PERSIST_KEY);
  globalStyle.textContent = `
    html[data-astro-wysiwyg-enabled] :is(${EDITABLE_SELECTOR}) { cursor: text; }
    html[data-astro-wysiwyg-enabled] :is([data-astro-wysiwyg-video], [data-astro-wysiwyg-iframe]) { cursor: default; }
    [data-astro-wysiwyg-iframe-shell] { display: inline-grid; max-width: 100%; position: relative; vertical-align: top; }
    [data-astro-wysiwyg-iframe-shell] > :is(iframe, button) { grid-area: 1 / 1; }
    [data-astro-wysiwyg-iframe-shell] > button { align-self: start; justify-self: start; margin: .5rem; min-height: 44px; padding: .5rem .75rem; position: relative; z-index: 1; }
    html[data-astro-wysiwyg-highlights] :is(${EDITABLE_SELECTOR}):hover { outline: 1px dashed Highlight; outline-offset: 3px; }
    html[data-astro-wysiwyg-highlights] :is(${EDITABLE_SELECTOR}):focus-visible,
    [${ACTIVE_ATTRIBUTE}] { outline: 2px solid Highlight !important; outline-offset: 3px; }
    [data-astro-wysiwyg-notice] {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647; box-sizing: border-box;
      display: flex; width: max-content; max-width: min(420px, calc(100vw - 32px));
      align-items: flex-start; gap: 12px; margin: 0; padding: 12px;
      color: #fef3c7; background: #78350f; border: 2px solid #f59e0b; border-radius: 6px;
      font: 600 15px/1.4 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 4px 12px rgb(0 0 0 / 30%); animation: wysiwyg-notice-in 0.2s ease-out;
    }
    [data-astro-wysiwyg-notice] > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
    [data-astro-wysiwyg-notice] > button {
      flex: 0 0 auto; min-width: 44px; min-height: 44px; margin: -6px; padding: 6px 8px;
      color: #fef3c7; background: transparent; border: 1px solid transparent; border-radius: 4px;
      font: 600 13px/1.2 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
    }
    [data-astro-wysiwyg-notice] > button:hover { background: #92400e; border-color: #f59e0b; }
    [data-astro-wysiwyg-notice] > button:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 2px; }
    @keyframes wysiwyg-notice-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { [data-astro-wysiwyg-notice] { animation: none; } }
  `;
  document.head.append(globalStyle);
  applyPreferences(preferences);

  prepareEditableBlocks(document);
  void restorePageState();
  document.addEventListener('astro:before-swap', onBeforeSwap);
  document.addEventListener('astro:page-load', onPageLoad);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('focusin', onDocumentFocus);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener(PREFERENCES_EVENT, onPreferences);
  document.addEventListener(FRONTMATTER_EVENT, () => void openFrontmatterEditor());
  document.addEventListener(CREATE_COLLECTION_ENTRY_EVENT, () => void openCollectionEntryEditor());
  window.addEventListener('scroll', positionToolbar, true);
  window.addEventListener('resize', positionToolbar);
  shadow.addEventListener('pointerdown', (event) => {
    if (event.composedPath().some((item) => item instanceof HTMLButtonElement)) event.preventDefault();
  });
  shadow.addEventListener('click', onToolbarClick);
  shadow.addEventListener('keydown', onToolbarKeyDown);
  shadow.addEventListener('focusin', onToolbarFocusIn);
  shadow.addEventListener('focusout', onToolbarFocusOut);
  shadow.addEventListener('pointerover', onToolbarPointerOver);
  shadow.addEventListener('pointerout', onToolbarPointerOut);
  shadow.addEventListener('input', (event) => {
    rememberFrontmatterDraft(event);
    onImageReferenceInput(event);
    onVideoReferenceInput(event);
    if (event.target instanceof Element && event.target.closest('.iframe-editor')) invalidateIframePreview();
  });
  shadow.addEventListener('change', onToolbarChange);
  const imageDialog = shadow.querySelector<HTMLDialogElement>('.image-editor');
  imageDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeImageEditor(true);
  });
  const videoDialog = shadow.querySelector<HTMLDialogElement>('.video-editor');
  videoDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeVideoEditor(true);
  });
  const iframeDialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor');
  iframeDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeIframeEditor(true);
  });
  const collectionDialog = shadow.querySelector<HTMLDialogElement>('.collection-entry-editor');
  collectionDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCollectionEntryEditor();
  });
  initializeToolbarFocus();

  function onBeforeSwap(event: Event): void {
    const newDocument = (event as Event & { newDocument: Document }).newDocument;
    prepareEditableBlocks(newDocument);
    addPersistencePlaceholder(newDocument.body, 'div', HOST_ID);
    addPersistencePlaceholder(newDocument.body, 'span', EDIT_INSTRUCTIONS_ID);
    addPersistencePlaceholder(newDocument.head, 'style', STYLE_PERSIST_KEY);
  }

  function addPersistencePlaceholder(parent: HTMLElement, tag: string, key: string): void {
    const placeholder = parent.ownerDocument.createElement(tag);
    placeholder.setAttribute(PERSIST_ATTRIBUTE, key);
    parent.append(placeholder);
  }

  function onPageLoad(): void {
    if (active && !active.isConnected) {
      active = null;
      toolbar.hidden = true;
      undoHistory = [];
    }
    closeFrontmatterEditor();
    closeImageEditor();
    closeVideoEditor();
    closeIframeEditor();
    closeCollectionEntryEditor();
    closeLinkEditor();
    applyPreferences(preferences);
    prepareEditableBlocks(document);
    void restorePageState();
  }

  async function restorePageState(): Promise<void> {
    await restoreActiveSession();
    await restoreFrontmatterDraft();
  }

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
      for (const element of document.querySelectorAll<HTMLElement>('[data-wysiwyg-added-description]')) {
        removeEditDescription(element);
      }
      /* istanbul ignore next -- Notices are cleaned up by their own timeout; this is defensive cleanup on disable. */
      for (const notice of document.querySelectorAll<HTMLElement>('[data-astro-wysiwyg-notice]')) {
        notice.remove();
      }
      for (const shell of document.querySelectorAll<HTMLElement>('[data-astro-wysiwyg-iframe-shell]')) {
        const iframe = shell.querySelector<HTMLIFrameElement>(':scope > iframe');
        if (iframe) shell.replaceWith(iframe);
        else shell.remove();
      }
      return;
    }
    prepareEditableBlocks(document);
  }

  function prepareEditableBlocks(root: ParentNode): void {
    const candidates = [...root.querySelectorAll<HTMLElement>(PREPARE_SELECTOR)];
    const elements = [...new Set(candidates.map((element) => {
      if (element.localName === 'p' && element.parentElement?.localName === 'blockquote'
        && element.parentElement.hasAttribute(MARKER_ATTRIBUTE)) {
        element.removeAttribute(MARKER_ATTRIBUTE);
        return element.parentElement;
      }
      if (element.localName === 'code' && element.parentElement?.localName === 'pre'
        && element.hasAttribute(MARKER_ATTRIBUTE)) {
        element.parentElement.setAttribute(MARKER_ATTRIBUTE, element.getAttribute(MARKER_ATTRIBUTE)!);
        element.removeAttribute(MARKER_ATTRIBUTE);
        return element.parentElement;
      }
      return element;
    }))];
    for (const element of elements) {
      const sourceFile = element.getAttribute('data-astro-source-file');
      const sourceLocation = element.getAttribute('data-astro-source-loc');
      if (sourceFile && sourceLocation) {
        element.dataset.wysiwygSourceFile = sourceFile;
        element.dataset.wysiwygSourceLoc = sourceLocation;
      }
    }
    if (!preferences.enabled) return;

    for (const element of elements) {
      if (element instanceof HTMLIFrameElement
        && !element.parentElement?.hasAttribute('data-astro-wysiwyg-iframe-shell')) {
        const shell = document.createElement('span');
        shell.dataset.astroWysiwygIframeShell = '';
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.astroWysiwygIframeEdit = '';
        button.textContent = 'Edit iframe';
        button.setAttribute('aria-label', `Edit iframe: ${element.title}`);
        element.before(shell);
        shell.append(element, button);
      }
    }

    const managed = elements.filter((element) => (
      element.hasAttribute('data-wysiwyg-added-tabindex') || !element.hasAttribute('tabindex')
    ));
    const roving = managed.find((element) => element === active)
      ?? managed.find((element) => element.hasAttribute('data-wysiwyg-added-tabindex') && element.tabIndex === 0)
      ?? managed[0];
    for (const element of managed) {
      element.tabIndex = element === roving ? 0 : -1;
      element.dataset.wysiwygAddedTabindex = '';
    }
    for (const element of elements) addEditDescription(element);
  }

  function setRovingTabStop(target: HTMLElement): void {
    if (!target.hasAttribute('data-wysiwyg-added-tabindex')) return;
    for (const element of document.querySelectorAll<HTMLElement>('[data-wysiwyg-added-tabindex]')) {
      element.tabIndex = element === target ? 0 : -1;
    }
  }

  function onDocumentFocus(event: FocusEvent): void {
    if (event.target instanceof HTMLElement && event.target.matches(EDITABLE_SELECTOR)) {
      setRovingTabStop(event.target);
    }
  }

  function moveEditableFocus(current: HTMLElement, direction: -1 | 1): void {
    const elements = [...document.querySelectorAll<HTMLElement>(EDITABLE_SELECTOR)];
    const index = elements.indexOf(current);
    const target = elements[(index + direction + elements.length) % elements.length];
    setRovingTabStop(target);
    target.focus();
  }

  function addEditDescription(element: HTMLElement): void {
    const descriptions = (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((id) => id !== EDIT_INSTRUCTIONS_ID);
    descriptions.push(EDIT_INSTRUCTIONS_ID);
    element.setAttribute('aria-describedby', descriptions.join(' '));
    element.dataset.wysiwygAddedDescription = '';
  }

  function removeEditDescription(element: HTMLElement): void {
    const descriptions = (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((id) => id !== EDIT_INSTRUCTIONS_ID);
    if (descriptions.length) element.setAttribute('aria-describedby', descriptions.join(' '));
    else element.removeAttribute('aria-describedby');
    delete element.dataset.wysiwygAddedDescription;
  }

  function showNonEditableNotice(message: string): void {
    for (const existing of document.querySelectorAll('[data-astro-wysiwyg-notice]')) existing.remove();
    const notice = document.createElement('div');
    notice.dataset.astroWysiwygNotice = '';
    notice.setAttribute('role', 'alert');
    notice.setAttribute('aria-atomic', 'true');
    const text = document.createElement('span');
    text.textContent = `Not editable: ${message}`;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    notice.append(text, dismiss);
    document.body.append(notice);
    setStatus(message, true);
    /* istanbul ignore next -- The timeout callback is tested visually. */
    const clear = () => { notice.remove(); };
    setTimeout(clear, 5000);
    dismiss.addEventListener('click', clear);
  }

  function onDocumentClick(event: MouseEvent): void {
    if (!preferences.enabled) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const iframeTrigger = target.closest<HTMLElement>('[data-astro-wysiwyg-iframe-edit]');
    let block = iframeTrigger?.parentElement?.querySelector<HTMLElement>(':scope > iframe')
      ?? target.closest<HTMLElement>(EDITABLE_SELECTOR);
    if (block?.localName === 'li') {
      const list = block.parentElement?.closest<HTMLElement>('ul, ol');
      /* istanbul ignore else -- Source-marked list items inherit a source-marked parent list. */
      if (list?.matches(EDITABLE_SELECTOR)) block = list;
    }
    if (block?.localName === 'p' && block.parentElement?.localName === 'blockquote'
      && block.parentElement.matches(EDITABLE_SELECTOR)) block = block.parentElement;
    if (block?.localName === 'code' && block.parentElement?.localName === 'pre'
      && block.parentElement.matches(EDITABLE_SELECTOR)) block = block.parentElement;
    if (!block) return;
    setRovingTabStop(block);
    const hasNativeAction = NATIVE_ACTION_TAGS.has(block.localName);
    if (target.closest('a') || hasNativeAction) event.preventDefault();
    if (hasNativeAction) event.stopPropagation();
    suppressRestoredAutosave = false;
    void activate(block);
  }

  async function activate(block: HTMLElement): Promise<HTMLElement | undefined> {
    if (!preferences.enabled) return undefined;
    if (!block.hasAttribute(MARKER_ATTRIBUTE)) {
      const resolved = await resolveSourceMarker(block);
      if (resolved !== true) {
        showNonEditableNotice(resolved);
        return undefined;
      }
    }
    const token = block.getAttribute(MARKER_ATTRIBUTE);
    const marker = decodeClientMarker(token);
    if (token && marker?.format === 'frontmatter') {
      await openFrontmatterEditor(undefined, token, marker.field);
      return undefined;
    }
    setRovingTabStop(block);
    if (active === block) return active;
    if (isFrontmatterEditorOpen()) closeFrontmatterEditor();
    if (isImageEditorOpen()) closeImageEditor();
    if (isVideoEditorOpen()) closeVideoEditor();
    if (isIframeEditorOpen()) closeIframeEditor();
    if (isLinkEditorOpen()) closeLinkEditor();
    if (active) {
      const previous = active;
      if (hasUnsavedChanges(previous)) {
        const saved = await queueSave(previous);
        if (!saved) {
          previous.focus({ preventScroll: true });
          return undefined;
        }
      }
      deactivate(previous);
    }
    active = block;
    contentUndo = undefined;
    removeEditDescription(active);
    active.setAttribute('contenteditable', String(
      !isVideoBlock(active) && !isIframeBlock(active) && !isStructuredStaticBlock(active),
    ));
    active.setAttribute(ACTIVE_ATTRIBUTE, '');
    undoHistory = [snapshot(active)];
    toolbar.hidden = false;
    updateUndoButton();
    updateStructureButtons();
    updateControlStates();
    setStatus(isVideoBlock(active)
      ? 'Video selected'
      : isIframeBlock(active)
        ? 'Iframe selected'
        : isStructuredStaticBlock(active)
          ? 'Static block selected'
          : 'Editing');
    positionToolbar();
    active.focus({ preventScroll: true });
    rememberActiveSession();
    return active;
  }

  async function restoreActiveSession(): Promise<void> {
    if (active) return;
    const session = readActiveSession();
    if (!session || session.pathname !== location.pathname) return;
    suppressRestoredAutosave = Boolean(session.suppressAutosave);
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
        .sort((left, right) => Math.abs(left.marker!.start - session.start!)
          - Math.abs(right.marker!.start - session.start!));
      block = candidates[0]?.element;
    }
    if (!block) return;
    let restored = await activate(block);
    if (!restored) return;
    const draftSnapshot = session.html !== undefined && session.tag !== undefined
      ? { html: session.html, tag: session.tag }
      : undefined;
    const currentSource = decodeClientMarker(restored.getAttribute(MARKER_ATTRIBUTE))?.original;
    const hasDraft = Boolean(session.dirty || session.saving || session.suppressAutosave);
    const sourceChanged = session.sourceOriginal !== undefined
      && currentSource !== undefined
      && session.sourceOriginal !== currentSource;
    let restoredDraftState: 'clean' | 'committed' | 'conflict' | 'pending' = 'clean';
    if (hasDraft) {
      if (session.sourceOriginal !== undefined && session.sourceOriginal === currentSource) {
        restoredDraftState = 'pending';
      } else if (draftSnapshot && sameSnapshot(snapshot(restored), draftSnapshot)) {
        restoredDraftState = 'committed';
      } else {
        restoredDraftState = 'conflict';
      }
    }
    suppressRestoredAutosave = Boolean(
      session.suppressAutosave || restoredDraftState === 'committed' || restoredDraftState === 'conflict',
    );
    if (session.history?.length && !(restoredDraftState === 'clean' && sourceChanged)) {
      undoHistory = session.history;
    }
    if (!(restoredDraftState === 'clean' && sourceChanged)) contentUndo = session.contentUndo;
    const shouldRestoreDraft = hasDraft && restoredDraftState !== 'committed';
    let draftRestored = false;
    if (shouldRestoreDraft && session.tag && restored.localName !== session.tag) {
      changeBlockTag(session.tag, false, false);
      /* istanbul ignore next -- Tag replacement always installs the replacement as active. */
      restored = active ?? restored;
      draftRestored = true;
    }
    if (shouldRestoreDraft && session.html !== undefined && restored.innerHTML !== session.html) {
      restored.innerHTML = session.html;
      draftRestored = true;
    }
    if (restoredDraftState === 'committed') checkpoint(restored);
    if (draftRestored && preferences.autosave && !suppressRestoredAutosave) {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => queueSave(restored), options.saveDelay);
    }
    setCaretOffset(restored, session.caret);
    rememberActiveSession();
    updateUndoButton();
    if (restoredDraftState === 'conflict') {
      setStatus('The source changed since this draft began. Review this block before saving again.', true);
    }
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
      dirty: hasUnsavedChanges(active) || activeSaveInFlight,
      saving: activeSaveInFlight,
      suppressAutosave: suppressRestoredAutosave,
      sourceOriginal: marker?.original,
      contentUndo,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // Editing still works when session storage is unavailable.
    }
  }

  async function resolveSourceMarker(element: HTMLElement): Promise<string | true> {
    const sourceFile = element.dataset.wysiwygSourceFile;
    const sourceLocation = element.dataset.wysiwygSourceLoc;
    /* istanbul ignore next -- The editable source selector requires both attributes. */
    if (!sourceFile || !sourceLocation) return 'This block has no source location.';
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
          renderedText: element.textContent!.trim(),
        }),
      });
      const body = await response.json() as SaveResponse;
      if (!response.ok || !body.marker) return body.error ?? 'This block could not be mapped to its source.';
      element.setAttribute(MARKER_ATTRIBUTE, body.marker);
      if (element.localName === 'figure'
        && element.querySelectorAll(':scope > video > source[type="video/mp4"]').length === 1) {
        element.setAttribute('data-astro-wysiwyg-video', '');
      } else if (element.localName === 'iframe') {
        element.setAttribute('data-astro-wysiwyg-iframe', '');
      }
      return true;
    } catch {
      return 'The source marker could not be resolved.';
    }
  }

  function deactivate(element: HTMLElement): void {
    element.removeAttribute('contenteditable');
    element.removeAttribute(ACTIVE_ATTRIBUTE);
    if (preferences.enabled) addEditDescription(element);
  }

  function onSelectionChange(): void {
    rememberActiveSession();
    updateControlStates();
  }

  function onInput(event: Event): void {
    if (event.target !== active || !active) return;
    window.clearTimeout(saveTimer);
    suppressRestoredAutosave = false;
    contentUndo = undefined;
    setStatus('Unsaved');
    rememberActiveSession();
    updateUndoButton();
    updateControlStates();
    if (preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
    positionToolbar();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!preferences.enabled) return;
    const target = event.target;
    if (!active && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && target instanceof HTMLElement && target.matches(EDITABLE_SELECTOR)) {
      event.preventDefault();
      moveEditableFocus(target, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (!active && event.key === 'Enter' && target instanceof HTMLElement && target.matches(EDITABLE_SELECTOR)) {
      event.preventDefault();
      void activate(target);
      return;
    }
    if (!active || !active.contains(target as Node)) return;

    const modifier = event.ctrlKey || event.metaKey;
    if (isVideoBlock(active)) {
      if (event.altKey && event.key === 'F10') {
        event.preventDefault();
        focusToolbar();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        void finishEditing();
      } else if (modifier || event.altKey && /^Digit[1-6]$/.test(event.code)) {
        event.preventDefault();
      }
      return;
    }
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
      focusToolbar();
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
    const target = event.target;
    if (event.key === 'Enter'
      && target instanceof HTMLInputElement
      && target.closest('.link-editor')) {
      event.preventDefault();
      applyLink();
      return;
    }
    if (target instanceof HTMLButtonElement && target.closest('[role="menu"]')) {
      const items = enabledMenuItems(target.closest<HTMLElement>('[role="menu"]')!);
      const index = items.indexOf(target);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + direction + items.length) % items.length]?.focus();
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
        return;
      }
    }
    if (target instanceof HTMLButtonElement && target.hasAttribute('data-toolbar-item')) {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.getAttribute('aria-haspopup') === 'menu') {
        event.preventDefault();
        const menuId = target.dataset.action === 'toggle-text-style'
          ? 'text-style-menu'
          : target.dataset.action === 'toggle-replace-content'
            ? 'replace-content-menu'
            : 'insert-menu';
        openMenu(menuId, event.key === 'ArrowUp');
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        moveToolbarFocus(target, event.key);
        return;
      }
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (hideOpenTooltip()) return;
    const openMenuElement = toolbar.querySelector<HTMLElement>('[role="menu"]:not([hidden])');
    if (openMenuElement) closeMenu(openMenuElement, true);
    else if (isFrontmatterEditorOpen()) closeFrontmatterEditor(true);
    else if (isImageEditorOpen()) closeImageEditor(true);
    else if (isVideoEditorOpen()) closeVideoEditor(true);
    else if (isIframeEditorOpen()) closeIframeEditor(true);
    else if (isLinkEditorOpen()) closeLinkEditor(true);
    else void finishEditing();
  }

  function toolbarControls(): HTMLButtonElement[] {
    return [...toolbar.querySelectorAll<HTMLButtonElement>('[data-toolbar-item]')];
  }

  function enabledToolbarControls(): HTMLButtonElement[] {
    return toolbarControls().filter((button) => !button.disabled);
  }

  function enabledMenuItems(menu: HTMLElement): HTMLButtonElement[] {
    return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled):not([hidden])')];
  }

  function initializeToolbarFocus(): void {
    const first = enabledToolbarControls()[0];
    for (const button of toolbarControls()) button.tabIndex = button === first ? 0 : -1;
  }

  function setRovingControl(control: HTMLButtonElement): void {
    for (const button of toolbarControls()) button.tabIndex = button === control ? 0 : -1;
    lastToolbarControl = control;
  }

  function focusToolbar(): void {
    const enabled = enabledToolbarControls();
    const target = lastToolbarControl && enabled.includes(lastToolbarControl)
      ? lastToolbarControl
      : enabled[0];
    /* istanbul ignore next -- The static toolbar always has an enabled non-media control. */
    if (!target) return;
    setRovingControl(target);
    target.focus();
  }

  function moveToolbarFocus(current: HTMLButtonElement, key: string): void {
    const controls = enabledToolbarControls();
    const index = controls.indexOf(current);
    /* istanbul ignore next -- Keyboard handling calls this only for an enabled toolbar control. */
    if (index < 0 || controls.length === 0) return;
    const target = key === 'Home'
      ? controls[0]
      : key === 'End'
        ? controls.at(-1)
        : controls[(index + (key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length];
    /* istanbul ignore next -- A non-empty enabled control list always yields a target. */
    if (!target) return;
    setRovingControl(target);
    target.focus();
  }

  function onToolbarFocusIn(event: Event): void {
    if (!(event instanceof FocusEvent) || !(event.target instanceof HTMLButtonElement)) return;
    if (event.target.hasAttribute('data-toolbar-item')) setRovingControl(event.target);
    showTooltip(event.target);
  }

  function onToolbarFocusOut(event: Event): void {
    if (!(event instanceof FocusEvent) || !(event.target instanceof HTMLButtonElement)) return;
    dismissedTooltip = undefined;
    hideTooltipFor(event.target);
  }

  function tooltipButton(target: EventTarget | null): HTMLButtonElement | undefined {
    return target instanceof Element
      ? target.closest<HTMLButtonElement>('button[data-tooltip]') ?? undefined
      : undefined;
  }

  function onToolbarPointerOver(event: Event): void {
    if (!(event instanceof PointerEvent)) return;
    const button = tooltipButton(event.target);
    if (button && button !== tooltipButton(event.relatedTarget)) showTooltip(button);
  }

  function onToolbarPointerOut(event: Event): void {
    if (!(event instanceof PointerEvent)) return;
    const button = tooltipButton(event.target);
    const tooltip = toolbar.querySelector<HTMLElement>('[role="tooltip"]');
    if (button && event.relatedTarget !== tooltip && !button.contains(event.relatedTarget as Node | null)) {
      dismissedTooltip = undefined;
      hideTooltipFor(button);
    } else if (tooltip && event.target === tooltip) {
      const owner = toolbar.querySelector<HTMLButtonElement>(`[data-tooltip-owner="${tooltip.dataset.owner}"]`);
      if (event.relatedTarget !== owner && !owner?.contains(event.relatedTarget as Node | null)) {
        tooltip.hidden = true;
        dismissedTooltip = undefined;
      }
    }
  }

  function showTooltip(button: HTMLButtonElement): void {
    const message = button.dataset.tooltip;
    const tooltip = toolbar.querySelector<HTMLElement>('[role="tooltip"]');
    /* istanbul ignore if -- Called for static tooltip buttons; dismissal is exercised through Escape. */
    if (!message || !tooltip || dismissedTooltip === button) return;
    tooltip.textContent = message;
    tooltip.dataset.owner = button.dataset.tooltipOwner as string;
    tooltip.hidden = false;
    positionSurface(tooltip, button, true);
  }

  function hideTooltipFor(button: HTMLButtonElement): void {
    const tooltip = toolbar.querySelector<HTMLElement>('[role="tooltip"]');
    if (tooltip && tooltip.dataset.owner === button.dataset.tooltipOwner) tooltip.hidden = true;
  }

  function hideOpenTooltip(): boolean {
    const tooltip = toolbar.querySelector<HTMLElement>('[role="tooltip"]:not([hidden])');
    if (!tooltip) return false;
    const owner = toolbar.querySelector<HTMLButtonElement>(`[data-tooltip-owner="${tooltip.dataset.owner}"]`);
    tooltip.hidden = true;
    /* istanbul ignore else -- Visible tooltips always retain their static owner button. */
    if (owner) dismissedTooltip = owner;
    return true;
  }

  function toggleMenu(id: string): void {
    const menu = toolbar.querySelector<HTMLElement>(`#${id}`);
    /* istanbul ignore next -- Callers use IDs from static menu markup. */
    if (!menu) return;
    if (menu.hidden) openMenu(id);
    else closeMenu(menu, true);
  }

  function openMenu(id: string, focusLast = false): void {
    const menu = toolbar.querySelector<HTMLElement>(`#${id}`);
    const trigger = toolbar.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`);
    /* istanbul ignore next -- Callers use matched static menu and trigger IDs. */
    if (!menu || !trigger) return;
    closeOpenMenus(false);
    if (isLinkEditorOpen()) closeLinkEditor();
    hideOpenTooltip();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionSurface(menu, trigger);
    const items = enabledMenuItems(menu);
    items[focusLast ? items.length - 1 : 0]?.focus();
  }

  function closeMenu(menu: HTMLElement, restoreFocus: boolean): void {
    menu.hidden = true;
    const trigger = toolbar.querySelector<HTMLButtonElement>(`[aria-controls="${menu.id}"]`);
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger) {
      setRovingControl(trigger);
      trigger.focus();
    }
  }

  function closeOpenMenus(restoreFocus: boolean): void {
    for (const menu of toolbar.querySelectorAll<HTMLElement>('[role="menu"]:not([hidden])')) {
      closeMenu(menu, restoreFocus);
    }
  }

  function positionSurface(surface: HTMLElement, trigger: HTMLElement, preferAbove = false): void {
    const inset = 8;
    const gap = surface.getAttribute('role') === 'tooltip' ? 0 : 6;
    const toolbarRect = toolbar.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const fitsBelow = triggerRect.bottom + gap + surfaceRect.height <= window.innerHeight - inset;
    const placeAbove = preferAbove || !fitsBelow;
    const viewportTop = placeAbove
      ? Math.max(inset, triggerRect.top - surfaceRect.height - gap)
      : Math.min(window.innerHeight - surfaceRect.height - inset, triggerRect.bottom + gap);
    const viewportLeft = Math.max(
      inset,
      Math.min(triggerRect.left, window.innerWidth - surfaceRect.width - inset),
    );
    surface.style.left = `${Math.round(viewportLeft - toolbarRect.left)}px`;
    surface.style.top = `${Math.round(viewportTop - toolbarRect.top)}px`;
  }

  function onImageReferenceInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'existing-reference') return;
    previewExistingImage(input.value);
    syncImagePrimaryButton();
  }

  function onVideoReferenceInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.name === 'existing-video-reference') {
      delete shadow.querySelector<HTMLDialogElement>('.video-editor')!.dataset.url;
      syncVideoPrimaryButton();
    }
    if (input.name === 'video-poster') {
      const preview = shadow.querySelector<HTMLVideoElement>('[data-video-preview]')!;
      const poster = input.value.trim();
      if (!preview.hidden && /^\/[A-Za-z0-9._/-]+\.(?:gif|jpe?g|png|webp)$/i.test(poster)) {
        preview.poster = poster;
      } else {
        preview.removeAttribute('poster');
      }
    }
  }

  function onToolbarChange(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLSelectElement && input.name === 'collection'
      && input.closest('.collection-entry-editor')) {
      renderCollectionFields();
      return;
    }
    if (input instanceof Element && input.closest('.iframe-editor')) {
      invalidateIframePreview();
      return;
    }
    /* istanbul ignore next -- Toolbar change controls are native inputs. */
    if (!(input instanceof HTMLInputElement)) return;
    if (input.name === 'video-source') {
      delete shadow.querySelector<HTMLDialogElement>('.video-editor')!.dataset.url;
      setVideoSourceMode(input.value === 'existing' ? 'existing' : 'upload');
      return;
    }
    if (input.name.startsWith('video-')) {
      onVideoFormChange(input);
      return;
    }
    if (input.name === 'image-source') {
      setImageSourceMode(input.value === 'existing' ? 'existing' : 'upload');
      return;
    }
    if (input.name !== 'image-file') return;
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor');
    const destination = dialog?.querySelector<HTMLInputElement>('[name="destination"]');
    const file = input.files?.[0];
    delete dialog?.dataset.url;
    /* istanbul ignore else -- The static file input always has its matched destination field. */
    if (destination && file) destination.value = suggestImageFilename(file.name);
    /* istanbul ignore else -- Supported browsers expose object URLs for selected files. */
    if (file && typeof URL.createObjectURL === 'function') {
      clearImageObjectUrl();
      imagePreviewObjectUrl = URL.createObjectURL(file);
      setImagePreview(imagePreviewObjectUrl);
    }
    syncImagePrimaryButton();
    setImageMessage('');
  }

  function openImageEditor(mode: 'insert' | 'replace'): void {
    /* istanbul ignore next -- Image actions are available only while a block is active. */
    if (!active) return;
    const selectedImage = mode === 'replace' && active.querySelectorAll('img').length === 1
      ? active.querySelector<HTMLImageElement>('img')
      : null;
    /* istanbul ignore next -- The contextual action is enabled only for one selected image. */
    if (mode === 'replace' && !selectedImage) return;
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor');
    const form = dialog?.querySelector<HTMLFormElement>('form');
    /* istanbul ignore next -- The dialog and form are static toolbar markup. */
    if (!dialog || !form) return;
    closeOpenMenus(false);
    form.reset();
    clearImageObjectUrl();
    delete dialog.dataset.url;
    dialog.dataset.mode = mode;
    dialog.dataset.returnAction = mode === 'replace' ? 'replace-image' : 'toggle-insert';
    const title = dialog.querySelector<HTMLElement>('h2')!;
    const primary = form.querySelector<HTMLButtonElement>('[data-action="insert-image"]')!;
    const sourceOptions = form.querySelector<HTMLFieldSetElement>('.image-source-options')!;
    const alt = form.querySelector<HTMLInputElement>('[name="alt"]')!;
    const label = mode === 'replace' ? 'Replace image' : 'Insert image';
    dialog.setAttribute('aria-label', label);
    title.textContent = label;
    primary.textContent = label;
    primary.setAttribute('aria-busy', 'false');
    sourceOptions.hidden = mode !== 'replace';
    const existingChoice = form.querySelector<HTMLInputElement>('[name="image-source"][value="existing"]')!;
    existingChoice.disabled = mode !== 'replace';
    setImageSourceMode('upload');
    if (selectedImage) alt.value = selectedImage.alt;
    if (selectedImage) setImagePreview(selectedImage.src);
    else setImagePreview('');
    setImageMessage('');
    dialog.showModal();
    form.querySelector<HTMLInputElement>('[name="image-file"]')?.focus();
  }

  function isImageEditorOpen(): boolean {
    /* istanbul ignore next -- The dialog is static toolbar markup. */
    return shadow.querySelector<HTMLDialogElement>('.image-editor')?.open ?? false;
  }

  function closeImageEditor(restoreTrigger = false): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor');
    const returnAction = dialog?.dataset.returnAction ?? 'toggle-insert';
    /* istanbul ignore else -- Close is called for an open static dialog or as idempotent cleanup. */
    if (dialog?.open) dialog.close();
    clearImageObjectUrl();
    if (!restoreTrigger) return;
    const trigger = toolbar.querySelector<HTMLButtonElement>(`[data-action="${returnAction}"]`);
    /* istanbul ignore else -- The image trigger is static toolbar markup. */
    if (trigger) {
      setRovingControl(trigger);
      trigger.focus({ preventScroll: true });
    }
  }

  function clearImageObjectUrl(): void {
    if (imagePreviewObjectUrl && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(imagePreviewObjectUrl);
    imagePreviewObjectUrl = undefined;
  }

  function setImagePreview(src: string): void {
    const preview = shadow.querySelector<HTMLImageElement>('[data-image-preview]');
    const frame = preview?.closest<HTMLElement>('.image-preview');
    /* istanbul ignore next -- The image preview is static dialog markup. */
    if (!preview || !frame) return;
    if (src) preview.src = src;
    else preview.removeAttribute('src');
    frame.hidden = !src;
  }

  function previewExistingImage(reference: string): void {
    const marker = active?.getAttribute(MARKER_ATTRIBUTE);
    const value = reference.trim();
    if (!marker || !value) {
      setImagePreview('');
      return;
    }
    const query = new URLSearchParams({ marker, reference: value });
    setImagePreview(`${imageUploadEndpoint(options.endpoint)}/preview?${query}`);
  }

  function setImageSourceMode(mode: 'existing' | 'upload'): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const uploadPanel = form.querySelector<HTMLElement>('[data-image-source-panel="upload"]')!;
    const existingPanel = form.querySelector<HTMLElement>('[data-image-source-panel="existing"]')!;
    const uploadChoice = form.querySelector<HTMLInputElement>('[name="image-source"][value="upload"]')!;
    const existingChoice = form.querySelector<HTMLInputElement>('[name="image-source"][value="existing"]')!;
    const file = form.querySelector<HTMLInputElement>('[name="image-file"]')!;
    const destination = form.querySelector<HTMLInputElement>('[name="destination"]')!;
    const reference = form.querySelector<HTMLInputElement>('[name="existing-reference"]')!;
    const upload = form.querySelector<HTMLButtonElement>('[data-action="upload-image"]')!;
    const existing = mode === 'existing' && dialog.dataset.mode === 'replace';
    uploadChoice.checked = !existing;
    existingChoice.checked = existing;
    uploadPanel.hidden = existing;
    existingPanel.hidden = !existing;
    file.disabled = existing || Boolean(dialog.dataset.url);
    destination.disabled = existing || Boolean(dialog.dataset.url);
    reference.disabled = !existing;
    upload.hidden = existing;
    if (existing) previewExistingImage(reference.value);
    syncImagePrimaryButton();
    (existing ? reference : file).focus();
  }

  function imageSource(): string | undefined {
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor')!;
    const existing = dialog.querySelector<HTMLInputElement>('[name="image-source"][value="existing"]')!.checked;
    const reference = dialog.querySelector<HTMLInputElement>('[name="existing-reference"]')!.value.trim();
    return existing ? reference || undefined : dialog.dataset.url;
  }

  function syncImagePrimaryButton(): void {
    const primary = shadow.querySelector<HTMLButtonElement>('.image-editor [data-action="insert-image"]')!;
    if (primary.getAttribute('aria-busy') !== 'true') primary.disabled = !imageSource();
  }

  function setImageMessage(message: string): void {
    const node = shadow.querySelector<HTMLElement>('.image-message');
    /* istanbul ignore else -- The message is static dialog markup. */
    if (node) node.textContent = message;
  }

  function setImageBusy(busy: boolean): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor')!;
    const upload = dialog.querySelector<HTMLButtonElement>('[data-action="upload-image"]')!;
    const primary = dialog.querySelector<HTMLButtonElement>('[data-action="insert-image"]')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('[data-action="cancel-image"]')!;
    upload.disabled = busy || Boolean(dialog.dataset.url);
    upload.setAttribute('aria-busy', String(busy));
    primary.disabled = busy || !imageSource();
    primary.setAttribute('aria-busy', String(busy));
    cancel.disabled = busy;
  }

  async function uploadImage(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor');
    const form = dialog?.querySelector<HTMLFormElement>('form');
    /* istanbul ignore next -- Upload is available only inside the static image form. */
    if (!dialog || !form) return;
    const fileInput = form.querySelector<HTMLInputElement>('[name="image-file"]');
    const destination = form.querySelector<HTMLInputElement>('[name="destination"]');
    /* Validate only the upload fields, not the alt text (needed at insert time). */
    /* istanbul ignore next -- The form elements are present in the static dialog markup. */
    if (!fileInput || !destination || !fileInput.reportValidity() || !destination.reportValidity()) return;
    const file = fileInput.files?.[0];
    /* istanbul ignore next -- The required file input is checked by reportValidity. */
    if (!file) return;
    setImageBusy(true);
    setImageMessage('Uploading image...');
    try {
      const response = await fetch(imageUploadEndpoint(options.endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Astro-Wysiwyg-Filename': destination.value.trim(),
        },
        body: file,
      });
      const body = await response.json() as MediaUploadResponse;
      /* istanbul ignore next -- The endpoint supplies an error for rejected or incomplete responses. */
      if (!response.ok || !body.uploaded || !body.url) {
        throw new Error(body.error ?? 'The image could not be uploaded.');
      }
      dialog.dataset.url = body.url;
      fileInput.disabled = true;
      destination.disabled = true;
      syncImagePrimaryButton();
      const nextAction = dialog.dataset.mode === 'replace'
        ? 'Replace the active image.'
        : 'Insert it after the active block.';
      setImageMessage(`Uploaded to ${body.url}. ${nextAction}`);
      setStatus('Image uploaded');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error ? error.message : 'The image could not be uploaded.';
      setImageMessage(message);
      setStatus(message, true);
    } finally {
      setImageBusy(false);
    }
  }

  async function applyImage(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.image-editor');
    const altInput = dialog?.querySelector<HTMLInputElement>('[name="alt"]');
    const src = imageSource();
    /* istanbul ignore next -- Apply is enabled only after a source is selected. */
    if (!dialog || !altInput || !src || !altInput.reportValidity()) return;
    const replacing = dialog.dataset.mode === 'replace';
    const primary = dialog.querySelector<HTMLButtonElement>('[data-action="insert-image"]')!;
    setImageBusy(true);
    const target = await structuralTarget();
    if (!target) {
      setImageBusy(false);
      return;
    }
    setImageMessage(replacing ? 'Replacing image...' : 'Inserting image...');
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marker: target.marker,
          operation: replacing ? 'replace-image' : 'insert-image-after',
          src,
          alt: altInput.value,
        }),
      });
      const body = await response.json() as SaveResponse;
      /* istanbul ignore next -- The endpoint always supplies an error for rejected requests. */
      if (!response.ok || !body.marker) {
        throw new Error(body.error ?? `The image could not be ${replacing ? 'replaced' : 'inserted'}.`);
      }

      if (replacing) {
        const image = target.element.querySelector<HTMLImageElement>('img');
        /* istanbul ignore next -- Replace is exposed only for a block with one image. */
        if (!image) throw new Error('The selected image is no longer available.');
        image.src = src.startsWith('/')
          ? src
          : `${imageUploadEndpoint(options.endpoint)}/preview?${new URLSearchParams({ marker: body.marker, reference: src })}`;
        image.alt = altInput.value.trim();
        target.element.setAttribute(MARKER_ATTRIBUTE, body.marker);
        checkpoint(target.element);
        closeImageEditor();
        updateStructureButtons();
        setStatus('Image replaced');
        return;
      }

      const paragraph = document.createElement('p');
      const image = document.createElement('img');
      image.src = src;
      image.alt = altInput.value.trim();
      paragraph.append(image);
      paragraph.setAttribute(MARKER_ATTRIBUTE, body.marker);
      closeImageEditor();
      /* istanbul ignore else -- Detached structural recovery is shared with the tested paragraph insert path. */
      if (target.element.isConnected) {
        target.element.after(paragraph);
        await activate(paragraph);
      } else {
        rememberInsertedBlock(body.marker, { html: paragraph.innerHTML, tag: 'p' });
        active = null;
        await restoreActiveSession();
      }
      setStatus('Image inserted');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error ? error.message : `The image could not be ${replacing ? 'replaced' : 'inserted'}.`;
      setImageMessage(message);
      setStatus(message, true);
    } finally {
      primary.setAttribute('aria-busy', 'false');
      setImageBusy(false);
    }
  }

  function onVideoFormChange(input: HTMLInputElement): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    if (input.name === 'video-file') {
      const file = input.files?.[0];
      const destination = dialog.querySelector<HTMLInputElement>('[name="video-destination"]')!;
      delete dialog.dataset.url;
      if (file) destination.value = suggestVideoFilename(file.name);
      if (file && typeof URL.createObjectURL === 'function') {
        clearVideoObjectUrl();
        videoPreviewObjectUrl = URL.createObjectURL(file);
        setVideoPreview(videoPreviewObjectUrl);
      } else if (!file) {
        setVideoPreview(dialog.dataset.currentUrl ?? '');
      }
      setVideoMessage('');
    }
    validateVideoOptions();
    syncVideoPrimaryButton();
  }

  function openVideoEditor(mode: 'insert' | 'replace' = 'insert'): void {
    /* istanbul ignore next -- Video actions are available only while a block is active. */
    if (!active) return;
    const selectedVideo = mode === 'replace' && isVideoBlock(active)
      ? active.querySelector<HTMLVideoElement>('video')
      : null;
    /* istanbul ignore next -- Replace is exposed only for a recognized native video figure. */
    if (mode === 'replace' && !selectedVideo) return;
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    closeOpenMenus(false);
    form.reset();
    clearVideoObjectUrl();
    delete dialog.dataset.url;
    delete dialog.dataset.currentUrl;
    dialog.dataset.mode = mode;
    dialog.dataset.returnAction = mode === 'replace' ? 'replace-video' : 'toggle-insert';
    const label = mode === 'replace' ? 'Replace video' : 'Insert video';
    dialog.setAttribute('aria-label', label);
    dialog.querySelector<HTMLElement>('h2')!.textContent = label;
    const primary = dialog.querySelector<HTMLButtonElement>('[data-action="insert-video"]')!;
    primary.textContent = label;
    primary.setAttribute('aria-busy', 'false');
    const sourceOptions = dialog.querySelector<HTMLFieldSetElement>('.video-source-options')!;
    sourceOptions.hidden = mode !== 'replace';
    const existingChoice = dialog.querySelector<HTMLInputElement>('[name="video-source"][value="existing"]')!;
    existingChoice.disabled = mode !== 'replace';
    const file = dialog.querySelector<HTMLInputElement>('[name="video-file"]')!;
    const destination = dialog.querySelector<HTMLInputElement>('[name="video-destination"]')!;
    file.required = mode === 'insert';
    destination.required = mode === 'insert';
    if (selectedVideo) {
      const source = selectedVideo.querySelector<HTMLSourceElement>('source')!;
      const caption = active.querySelector<HTMLElement>('figcaption')!;
      const currentUrl = source.getAttribute('src')!;
      dialog.dataset.currentUrl = currentUrl;
      dialog.querySelector<HTMLInputElement>('[name="existing-video-reference"]')!.value = currentUrl;
      dialog.querySelector<HTMLInputElement>('[name="video-label"]')!.value = selectedVideo.getAttribute('aria-label')!;
      dialog.querySelector<HTMLTextAreaElement>('[name="video-description"]')!.value = caption.textContent!.trim();
      dialog.querySelector<HTMLInputElement>('[name="video-poster"]')!.value = selectedVideo.getAttribute('poster') ?? '';
      dialog.querySelector<HTMLSelectElement>('[name="video-preload"]')!.value = selectedVideo.getAttribute('preload')!;
      dialog.querySelector<HTMLInputElement>('[name="video-controls"]')!.checked = selectedVideo.hasAttribute('controls');
      dialog.querySelector<HTMLInputElement>('[name="video-muted"]')!.checked = selectedVideo.hasAttribute('muted');
      dialog.querySelector<HTMLInputElement>('[name="video-loop"]')!.checked = selectedVideo.hasAttribute('loop');
      dialog.querySelector<HTMLInputElement>('[name="video-autoplay"]')!.checked = selectedVideo.hasAttribute('autoplay');
      setVideoPreview(currentUrl);
    } else {
      setVideoPreview('');
    }
    setVideoSourceMode('upload');
    validateVideoOptions();
    setVideoMessage('');
    dialog.showModal();
    file.focus();
  }

  function isVideoBlock(element: HTMLElement | null): boolean {
    return Boolean(element?.hasAttribute('data-astro-wysiwyg-video')
      && element.querySelectorAll(':scope > video').length === 1
      && element.querySelectorAll(':scope > figcaption').length === 1
      && element.querySelectorAll(':scope > video > source[type="video/mp4"]').length === 1);
  }

  function isVideoEditorOpen(): boolean {
    /* istanbul ignore next -- The toolbar template always includes the video dialog. */
    return shadow.querySelector<HTMLDialogElement>('.video-editor')?.open ?? false;
  }

  function closeVideoEditor(restoreTrigger = false): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor');
    const returnAction = dialog?.dataset.returnAction ?? 'toggle-insert';
    if (dialog?.open) dialog.close();
    clearVideoObjectUrl();
    if (!restoreTrigger) return;
    const trigger = toolbar.querySelector<HTMLButtonElement>(`[data-action="${returnAction}"]`);
    /* istanbul ignore else -- The video trigger is static toolbar markup. */
    if (trigger) {
      setRovingControl(trigger);
      trigger.focus({ preventScroll: true });
    }
  }

  function clearVideoObjectUrl(): void {
    if (videoPreviewObjectUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(videoPreviewObjectUrl);
    }
    videoPreviewObjectUrl = undefined;
  }

  function setVideoPreview(src: string): void {
    const preview = shadow.querySelector<HTMLVideoElement>('[data-video-preview]')!;
    const poster = shadow.querySelector<HTMLInputElement>('[name="video-poster"]')!.value.trim();
    if (src) {
      preview.src = src;
      if (/^\/[A-Za-z0-9._/-]+\.(?:gif|jpe?g|png|webp)$/i.test(poster)) preview.poster = poster;
      else preview.removeAttribute('poster');
      preview.hidden = false;
      preview.load();
    } else {
      preview.removeAttribute('src');
      preview.removeAttribute('poster');
      preview.hidden = true;
    }
  }

  function setVideoSourceMode(mode: 'existing' | 'upload'): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const replacing = dialog.dataset.mode === 'replace';
    const existing = replacing && mode === 'existing';
    const uploadChoice = dialog.querySelector<HTMLInputElement>('[name="video-source"][value="upload"]')!;
    const existingChoice = dialog.querySelector<HTMLInputElement>('[name="video-source"][value="existing"]')!;
    const uploadPanel = dialog.querySelector<HTMLElement>('[data-video-source-panel="upload"]')!;
    const existingPanel = dialog.querySelector<HTMLElement>('[data-video-source-panel="existing"]')!;
    const file = dialog.querySelector<HTMLInputElement>('[name="video-file"]')!;
    const destination = dialog.querySelector<HTMLInputElement>('[name="video-destination"]')!;
    const reference = dialog.querySelector<HTMLInputElement>('[name="existing-video-reference"]')!;
    const upload = dialog.querySelector<HTMLButtonElement>('[data-action="upload-video"]')!;
    const preview = dialog.querySelector<HTMLButtonElement>('[data-action="preview-video"]')!;
    uploadChoice.checked = !existing;
    existingChoice.checked = existing;
    uploadPanel.hidden = existing;
    existingPanel.hidden = !existing;
    file.disabled = existing || Boolean(dialog.dataset.url);
    destination.disabled = existing || Boolean(dialog.dataset.url);
    reference.disabled = !existing;
    reference.required = existing;
    upload.hidden = existing;
    preview.hidden = !existing;
    if (!existing && dialog.dataset.currentUrl && !file.files?.length) setVideoPreview(dialog.dataset.currentUrl);
    syncVideoPrimaryButton();
    (existing ? reference : file).focus();
  }

  function videoSource(): string | undefined {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const existing = dialog.querySelector<HTMLInputElement>('[name="video-source"][value="existing"]')!.checked;
    if (existing) return dialog.dataset.url;
    const file = dialog.querySelector<HTMLInputElement>('[name="video-file"]')!;
    return dialog.dataset.url ?? (!file.files?.length ? dialog.dataset.currentUrl : undefined);
  }

  async function previewExistingVideo(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const reference = dialog.querySelector<HTMLInputElement>('[name="existing-video-reference"]')!;
    if (!reference.reportValidity()) return;
    setVideoBusy(true);
    setVideoMessage('Checking video...');
    try {
      const query = new URLSearchParams({ reference: reference.value.trim() });
      const response = await fetch(`${videoUploadEndpoint(options.endpoint)}/preview?${query}`);
      const body = await response.json() as SaveResponse & { url?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? 'The video could not be previewed.');
      dialog.dataset.url = body.url;
      setVideoPreview(body.url);
      setVideoMessage(`Using existing video ${body.url}.`);
      setStatus('Video ready');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error ? error.message : 'The video could not be previewed.';
      setVideoMessage(message);
      setStatus(message, true);
    } finally {
      setVideoBusy(false);
    }
  }

  function validateVideoOptions(): boolean {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const controls = dialog.querySelector<HTMLInputElement>('[name="video-controls"]')!;
    const muted = dialog.querySelector<HTMLInputElement>('[name="video-muted"]')!;
    const autoplay = dialog.querySelector<HTMLInputElement>('[name="video-autoplay"]')!;
    controls.setCustomValidity(controls.checked ? '' : 'Native video controls are required.');
    autoplay.setCustomValidity(autoplay.checked && !muted.checked ? 'Autoplay requires muted playback.' : '');
    return controls.checkValidity() && autoplay.checkValidity();
  }

  function setVideoMessage(message: string): void {
    shadow.querySelector<HTMLElement>('.video-message')!.textContent = message;
  }

  function syncVideoPrimaryButton(): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const insert = dialog.querySelector<HTMLButtonElement>('[data-action="insert-video"]')!;
    if (insert.getAttribute('aria-busy') !== 'true') insert.disabled = !videoSource();
  }

  function setVideoBusy(busy: boolean): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const upload = dialog.querySelector<HTMLButtonElement>('[data-action="upload-video"]')!;
    const insert = dialog.querySelector<HTMLButtonElement>('[data-action="insert-video"]')!;
    const preview = dialog.querySelector<HTMLButtonElement>('[data-action="preview-video"]')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('[data-action="cancel-video"]')!;
    upload.disabled = busy || Boolean(dialog.dataset.url);
    preview.disabled = busy;
    upload.setAttribute('aria-busy', String(busy));
    insert.disabled = busy || !videoSource();
    insert.setAttribute('aria-busy', String(busy));
    cancel.disabled = busy;
  }

  async function uploadVideo(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const fileInput = form.querySelector<HTMLInputElement>('[name="video-file"]')!;
    const destination = form.querySelector<HTMLInputElement>('[name="video-destination"]')!;
    /* Validate only the upload fields, not the label/description (needed at insert time). */
    if (!validateVideoOptions() || !fileInput.reportValidity() || !destination.reportValidity()) return;
    const file = fileInput.files?.[0];
    /* istanbul ignore next -- The required file is checked by reportValidity. */
    if (!file) return;
    setVideoBusy(true);
    setVideoMessage('Uploading video...');
    try {
      const response = await fetch(videoUploadEndpoint(options.endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Astro-Wysiwyg-Filename': destination.value.trim(),
        },
        body: file,
      });
      const body = await response.json() as MediaUploadResponse;
      if (!response.ok || !body.uploaded || !body.url) {
        throw new Error(body.error ?? 'The video could not be uploaded.');
      }
      dialog.dataset.url = body.url;
      fileInput.disabled = true;
      destination.disabled = true;
      syncVideoPrimaryButton();
      const nextAction = dialog.dataset.mode === 'replace'
        ? 'Replace the active video.'
        : 'Insert it after the active block.';
      setVideoMessage(`Uploaded to ${body.url}. ${nextAction}`);
      setStatus('Video uploaded');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error ? error.message : 'The video could not be uploaded.';
      setVideoMessage(message);
      setStatus(message, true);
    } finally {
      setVideoBusy(false);
    }
  }

  async function insertVideo(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.video-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const src = videoSource();
    if (!src || !validateVideoOptions() || !form.reportValidity()) return;
    const target = await structuralTarget();
    if (!target) return;
    const replacing = dialog.dataset.mode === 'replace';
    setVideoBusy(true);
    setVideoMessage(replacing ? 'Replacing video...' : 'Inserting video...');
    const value = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string): T => (
      form.querySelector<T>(`[name="${name}"]`)!
    );
    const request = {
      marker: target.marker,
      operation: replacing ? 'replace-video' : 'insert-video-after',
      src,
      label: value<HTMLInputElement>('video-label').value,
      description: value<HTMLTextAreaElement>('video-description').value,
      poster: value<HTMLInputElement>('video-poster').value.trim() || undefined,
      controls: value<HTMLInputElement>('video-controls').checked,
      preload: value<HTMLSelectElement>('video-preload').value,
      muted: value<HTMLInputElement>('video-muted').checked,
      loop: value<HTMLInputElement>('video-loop').checked,
      autoplay: value<HTMLInputElement>('video-autoplay').checked,
    };
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json() as SaveResponse;
      if (!response.ok || !body.marker) {
        throw new Error(body.error ?? `The video could not be ${replacing ? 'replaced' : 'inserted'}.`);
      }

      if (replacing) {
        const video = target.element.querySelector<HTMLVideoElement>(':scope > video')!;
        const source = video.querySelector<HTMLSourceElement>(':scope > source[type="video/mp4"]')!;
        const oldSource = source.getAttribute('src');
        source.src = src;
        video.controls = request.controls;
        video.preload = request.preload as 'auto' | 'metadata' | 'none';
        video.setAttribute('aria-label', request.label.trim());
        video.toggleAttribute('muted', request.muted);
        video.toggleAttribute('loop', request.loop);
        video.toggleAttribute('autoplay', request.autoplay);
        if (request.poster) video.poster = request.poster;
        else video.removeAttribute('poster');
        for (const anchor of video.querySelectorAll<HTMLAnchorElement>('a[href]')) {
          if (anchor.getAttribute('href') === oldSource) anchor.href = src;
        }
        target.element.querySelector<HTMLElement>(':scope > figcaption')!.textContent = request.description.trim();
        target.element.setAttribute(MARKER_ATTRIBUTE, body.marker);
        video.load();
        checkpoint(target.element);
        closeVideoEditor();
        updateStructureButtons();
        setStatus('Video replaced');
        return;
      }

      const figure = document.createElement('figure');
      const video = document.createElement('video');
      video.controls = true;
      video.preload = request.preload as 'auto' | 'metadata' | 'none';
      video.setAttribute('aria-label', request.label.trim());
      video.toggleAttribute('muted', request.muted);
      video.toggleAttribute('loop', request.loop);
      video.toggleAttribute('autoplay', request.autoplay);
      video.setAttribute('playsinline', '');
      if (request.poster) video.poster = request.poster;
      const source = document.createElement('source');
      source.src = src;
      source.type = 'video/mp4';
      const download = document.createElement('a');
      download.href = src;
      download.textContent = `Download ${request.label.trim()}`;
      video.append(source, download, '.');
      const caption = document.createElement('figcaption');
      caption.textContent = request.description.trim();
      figure.append(video, caption);
      figure.setAttribute(MARKER_ATTRIBUTE, body.marker);
      figure.setAttribute('data-astro-wysiwyg-video', '');
      closeVideoEditor();
      if (target.element.isConnected) target.element.after(figure);
      setStatus('Video inserted');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error
        ? error.message
        : `The video could not be ${replacing ? 'replaced' : 'inserted'}.`;
      setVideoMessage(message);
      setStatus(message, true);
    } finally {
      setVideoBusy(false);
    }
  }

  function isStructuredStaticBlock(element: HTMLElement | null): boolean {
    return Boolean(element && ['blockquote', 'pre', 'hr'].includes(element.localName)
      && contentBlockTypeFromTag(element.localName));
  }

  function isIframeBlock(element: HTMLElement | null): element is HTMLIFrameElement {
    return element instanceof HTMLIFrameElement
      && element.hasAttribute('data-astro-wysiwyg-iframe');
  }

  function isIframeEditorOpen(): boolean {
    return shadow.querySelector<HTMLDialogElement>('.iframe-editor')!.open;
  }

  function closeIframeEditor(restoreTrigger = false): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor')!;
    const returnAction = dialog.dataset.returnAction ?? 'toggle-insert';
    if (dialog.open) dialog.close();
    dialog.querySelector('[data-iframe-preview]')?.remove();
    if (!restoreTrigger) return;
    const trigger = toolbar.querySelector<HTMLButtonElement>(`[data-action="${returnAction}"]`)!;
    setRovingControl(trigger);
    trigger.focus({ preventScroll: true });
  }

  function iframeTokens(form: HTMLFormElement, name: string): string[] {
    return [...form.querySelectorAll<HTMLInputElement>(`[name="${name}"]:checked`)]
      .map((input) => input.value);
  }

  function iframeRequest(form: HTMLFormElement, marker: string, replacing: boolean) {
    const value = <T extends HTMLInputElement | HTMLSelectElement>(name: string): T => (
      form.querySelector<T>(`[name="${name}"]`)!
    );
    return {
      operation: replacing ? 'replace-iframe' : 'insert-iframe-after',
      marker,
      src: value<HTMLInputElement>('iframe-src').value.trim(),
      title: value<HTMLInputElement>('iframe-title').value.trim(),
      width: Number(value<HTMLInputElement>('iframe-width').value),
      height: Number(value<HTMLInputElement>('iframe-height').value),
      loading: value<HTMLSelectElement>('iframe-loading').value,
      referrerPolicy: value<HTMLSelectElement>('iframe-referrer-policy').value,
      allow: iframeTokens(form, 'iframe-allow'),
      sandbox: iframeTokens(form, 'iframe-sandbox'),
      allowFullscreen: value<HTMLInputElement>('iframe-allow-fullscreen').checked,
    };
  }

  function setIframeAttributes(iframe: HTMLIFrameElement, request: ReturnType<typeof iframeRequest>): void {
    iframe.setAttribute('title', request.title);
    iframe.setAttribute('width', String(request.width));
    iframe.setAttribute('height', String(request.height));
    iframe.setAttribute('loading', request.loading);
    iframe.setAttribute('referrerpolicy', request.referrerPolicy);
    iframe.setAttribute('sandbox', request.sandbox.join(' '));
    if (request.allow.length) iframe.setAttribute('allow', request.allow.join('; '));
    else iframe.removeAttribute('allow');
    iframe.toggleAttribute('allowfullscreen', request.allowFullscreen);
    iframe.setAttribute('src', request.src);
  }

  function invalidateIframePreview(): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor')!;
    delete dialog.dataset.validatedFields;
    dialog.querySelector<HTMLButtonElement>('[data-action="apply-iframe"]')!.disabled = true;
    const preview = dialog.querySelector<HTMLIFrameElement>('[data-iframe-preview]');
    if (preview) preview.hidden = true;
    setIframeMessage('Preview the validated iframe before saving.');
  }

  function openIframeEditor(mode: 'insert' | 'replace' = 'insert'): void {
    /* istanbul ignore next -- Iframe actions are available only while a block is active. */
    if (!active) return;
    const selected = mode === 'replace' && isIframeBlock(active) ? active : null;
    if (mode === 'replace' && !selected) return;
    const dialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    closeOpenMenus(false);
    form.reset();
    dialog.dataset.mode = mode;
    dialog.dataset.returnAction = mode === 'replace' ? 'replace-iframe' : 'toggle-insert';
    delete dialog.dataset.validatedFields;
    const label = mode === 'replace' ? 'Edit iframe' : 'Insert iframe';
    dialog.setAttribute('aria-label', label);
    dialog.querySelector<HTMLElement>('h2')!.textContent = label;
    dialog.querySelector<HTMLButtonElement>('[data-action="apply-iframe"]')!.textContent = label;
    /* istanbul ignore next -- Integration injection always supplies the normalized default. */
    const iframeOrigins = options.iframeOrigins ?? ['self'];
    dialog.querySelector<HTMLElement>('[data-iframe-origins]')!.textContent = `Allowed sources: ${iframeOrigins.join(', ')}.`;
    if (selected) {
      const set = (name: string, value: string) => {
        form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!.value = value;
      };
      set('iframe-src', selected.getAttribute('src')!);
      set('iframe-title', selected.title);
      set('iframe-width', selected.getAttribute('width')!);
      set('iframe-height', selected.getAttribute('height')!);
      set('iframe-loading', selected.getAttribute('loading')!);
      set('iframe-referrer-policy', selected.getAttribute('referrerpolicy')!);
      const allow = new Set((selected.getAttribute('allow') ?? '').split(';').map((token) => token.trim()));
      const sandbox = new Set(selected.getAttribute('sandbox')!.split(/\s+/));
      for (const input of form.querySelectorAll<HTMLInputElement>('[name="iframe-allow"]')) input.checked = allow.has(input.value);
      for (const input of form.querySelectorAll<HTMLInputElement>('[name="iframe-sandbox"]')) input.checked = sandbox.has(input.value);
      form.querySelector<HTMLInputElement>('[name="iframe-allow-fullscreen"]')!.checked = selected.hasAttribute('allowfullscreen');
    }
    invalidateIframePreview();
    dialog.showModal();
    form.querySelector<HTMLInputElement>('[name="iframe-src"]')!.focus();
  }

  function setIframeMessage(message: string): void {
    shadow.querySelector<HTMLElement>('.iframe-message')!.textContent = message;
  }

  function setIframeBusy(busy: boolean): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor')!;
    const preview = dialog.querySelector<HTMLButtonElement>('[data-action="preview-iframe"]')!;
    const apply = dialog.querySelector<HTMLButtonElement>('[data-action="apply-iframe"]')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('[data-action="cancel-iframe"]')!;
    preview.disabled = busy;
    preview.setAttribute('aria-busy', String(busy));
    apply.disabled = busy || !dialog.dataset.validatedFields;
    apply.setAttribute('aria-busy', String(busy));
    cancel.disabled = busy;
  }

  async function previewIframe(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    if (!form.reportValidity()) return;
    const request = iframeRequest(form, '', false);
    const validatedFields = JSON.stringify(request);
    setIframeBusy(true);
    setIframeMessage('Checking iframe...');
    try {
      const response = await fetch(`${options.endpoint.replace(/\/$/, '')}/iframes/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json() as SaveResponse & { src?: string };
      if (!response.ok || !body.src) throw new Error(body.error ?? 'The iframe could not be previewed.');
      if (JSON.stringify(iframeRequest(form, '', false)) !== validatedFields) {
        invalidateIframePreview();
        return;
      }
      const container = dialog.querySelector<HTMLElement>('[data-iframe-preview-container]')!;
      let preview = container.querySelector<HTMLIFrameElement>('[data-iframe-preview]');
      if (!preview) {
        preview = document.createElement('iframe');
        preview.className = 'iframe-preview';
        preview.dataset.iframePreview = '';
        preview.title = 'Iframe preview';
        container.append(preview);
      }
      setIframeAttributes(preview, request);
      preview.hidden = false;
      dialog.dataset.validatedFields = validatedFields;
      setIframeMessage('Iframe validated. Review the preview, then save it.');
      setStatus('Iframe ready');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error ? error.message : 'The iframe could not be previewed.';
      delete dialog.dataset.validatedFields;
      setIframeMessage(message);
      setStatus(message, true);
    } finally {
      setIframeBusy(false);
    }
  }

  async function applyIframe(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.iframe-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const validatedFields = JSON.stringify(iframeRequest(form, '', false));
    if (!form.reportValidity() || dialog.dataset.validatedFields !== validatedFields) {
      invalidateIframePreview();
      return;
    }
    const target = await structuralTarget();
    if (!target) return;
    const replacing = dialog.dataset.mode === 'replace';
    const request = iframeRequest(form, target.marker, replacing);
    setIframeBusy(true);
    setIframeMessage(replacing ? 'Updating iframe...' : 'Inserting iframe...');
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json() as SaveResponse;
      if (!response.ok || !body.marker) throw new Error(body.error ?? `The iframe could not be ${replacing ? 'updated' : 'inserted'}.`);
      if (replacing && isIframeBlock(target.element)) {
        setIframeAttributes(target.element, request);
        target.element.setAttribute(MARKER_ATTRIBUTE, body.marker);
        const editButton = target.element.parentElement!.querySelector<HTMLButtonElement>('[data-astro-wysiwyg-iframe-edit]')!;
        editButton.setAttribute('aria-label', `Edit iframe: ${request.title}`);
        checkpoint(target.element);
        closeIframeEditor();
        updateStructureButtons();
        setStatus('Iframe updated');
        return;
      }
      const iframe = document.createElement('iframe');
      setIframeAttributes(iframe, request);
      iframe.setAttribute(MARKER_ATTRIBUTE, body.marker);
      iframe.dataset.astroWysiwygIframe = '';
      closeIframeEditor();
      if (target.element.isConnected) {
        target.element.after(iframe);
        prepareEditableBlocks(document);
        await activate(iframe);
      } else {
        rememberInsertedBlock(body.marker, { html: iframe.outerHTML, tag: 'iframe' });
        active = null;
        await restoreActiveSession();
      }
      setStatus('Iframe inserted');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error ? error.message : `The iframe could not be ${replacing ? 'updated' : 'inserted'}.`;
      setIframeMessage(message);
      setStatus(message, true);
    } finally {
      setIframeBusy(false);
    }
  }

  function closeCollectionEntryEditor(): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.collection-entry-editor')!;
    if (dialog.open) dialog.close();
  }

  function setCollectionEntryMessage(message: string): void {
    shadow.querySelector<HTMLElement>('.collection-entry-message')!.textContent = message;
  }

  function setCollectionEntryBusy(busy: boolean): void {
    const dialog = shadow.querySelector<HTMLDialogElement>('.collection-entry-editor')!;
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
      'input, select, textarea, button',
    )) control.disabled = busy;
  }

  async function openCollectionEntryEditor(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.collection-entry-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    closeFrontmatterEditor();
    closeImageEditor();
    closeVideoEditor();
    closeIframeEditor();
    closeOpenMenus(false);
    form.reset();
    dialog.querySelector<HTMLElement>('[data-collection-success]')!.hidden = true;
    dialog.querySelector<HTMLElement>('[data-collection-form-fields]')!.hidden = false;
    dialog.querySelector<HTMLButtonElement>('[data-action="create-collection-entry"]')!.hidden = false;
    writableCollections = [];
    renderCollectionOptions();
    renderUnsupportedCollections([]);
    renderCollectionFields();
    setCollectionEntryMessage('Loading writable collections...');
    setCollectionEntryBusy(true);
    dialog.showModal();
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collections: 'discover' }),
      });
      const body = await response.json() as CollectionDiscoveryResponse;
      if (!response.ok || !Array.isArray(body.collections) || !Array.isArray(body.unsupported)) {
        throw new Error(body.error ?? 'Writable collections could not be loaded.');
      }
      writableCollections = body.collections;
      renderCollectionOptions();
      renderUnsupportedCollections(body.unsupported);
      renderCollectionFields();
      setCollectionEntryMessage(writableCollections.length
        ? 'Choose a collection, complete its required fields, and create the entry.'
        : 'No writable local collections were found. Review the unsupported collection details below.');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      setCollectionEntryMessage(error instanceof Error ? error.message : 'Writable collections could not be loaded.');
      renderUnsupportedCollections([]);
    } finally {
      setCollectionEntryBusy(false);
      const create = dialog.querySelector<HTMLButtonElement>('[data-action="create-collection-entry"]')!;
      create.disabled = writableCollections.length === 0;
      const first = writableCollections.length
        ? dialog.querySelector<HTMLSelectElement>('[name="collection"]')
        : dialog.querySelector<HTMLButtonElement>('[data-action="cancel-collection-entry"]');
      first?.focus();
    }
  }

  function renderCollectionOptions(): void {
    const select = shadow.querySelector<HTMLSelectElement>('.collection-entry-editor [name="collection"]')!;
    select.replaceChildren();
    for (const collection of writableCollections) {
      const option = document.createElement('option');
      option.value = collection.name;
      option.textContent = `${collection.name} (${collection.directory}, ${collection.extension})`;
      select.append(option);
    }
  }

  function renderUnsupportedCollections(unsupported: Array<{ name: string; reason: string }>): void {
    const region = shadow.querySelector<HTMLElement>('[data-unsupported-collections]')!;
    region.replaceChildren();
    if (!unsupported.length) {
      region.hidden = true;
      return;
    }
    region.hidden = false;
    const heading = document.createElement('h3');
    heading.textContent = 'Unavailable collections';
    const list = document.createElement('ul');
    for (const collection of unsupported) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = collection.name;
      item.append(name, document.createTextNode(`: ${collection.reason}`));
      list.append(item);
    }
    region.append(heading, list);
  }

  function selectedCollection(): WritableCollectionResponse | undefined {
    const name = shadow.querySelector<HTMLSelectElement>('.collection-entry-editor [name="collection"]')!.value;
    return writableCollections.find((collection) => collection.name === name);
  }

  function renderCollectionFields(): void {
    const container = shadow.querySelector<HTMLElement>('[data-collection-fields]')!;
    const omitted = shadow.querySelector<HTMLElement>('[data-omitted-collection-fields]')!;
    container.replaceChildren();
    omitted.replaceChildren();
    const collection = selectedCollection();
    if (!collection) return;
    for (const field of collection.fields) {
      const label = document.createElement('label');
      label.className = 'collection-field';
      const text = document.createElement('span');
      text.textContent = `${field.name}${field.required ? ' (required)' : ''}`;
      const input = document.createElement('input');
      input.name = `collection-field-${field.name}`;
      input.dataset.collectionField = field.name;
      input.dataset.collectionFieldType = field.type;
      if (field.type === 'boolean') {
        input.type = 'checkbox';
        input.checked = field.defaultValue === true;
      } else {
        input.type = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text';
        if (field.type === 'number') input.step = 'any';
        if (field.type === 'list') input.placeholder = 'item one, item two';
        if (typeof field.defaultValue === 'string') input.value = field.defaultValue;
        input.required = field.required;
      }
      label.append(text, input);
      container.append(label);
    }
    if (collection.omittedFields?.length) {
      omitted.textContent = `Optional fields not shown: ${collection.omittedFields.map(({ name }) => name).join(', ')}.`;
    }
  }

  async function createCollectionEntry(): Promise<void> {
    const dialog = shadow.querySelector<HTMLDialogElement>('.collection-entry-editor')!;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    if (!form.reportValidity()) return;
    const collection = selectedCollection();
    if (!collection) {
      setCollectionEntryMessage('Choose a writable collection.');
      return;
    }
    const values: Record<string, string | boolean> = {};
    for (const field of collection.fields) {
      const input = form.querySelector<HTMLInputElement>(`[data-collection-field="${CSS.escape(field.name)}"]`)!;
      values[field.name] = field.type === 'boolean' ? input.checked : input.value;
    }
    const slug = form.querySelector<HTMLInputElement>('[name="slug"]')!.value.trim();
    const starterBody = form.querySelector<HTMLTextAreaElement>('[name="body"]')!.value;
    setCollectionEntryBusy(true);
    setCollectionEntryMessage('Creating collection entry...');
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collections: 'create', collection: collection.name, slug, values, body: starterBody,
        }),
      });
      const body = await response.json() as CollectionCreateResponse;
      if (!response.ok || !body.created || !body.file) {
        throw new Error(body.error ?? 'The collection entry could not be created.');
      }
      const formFields = dialog.querySelector<HTMLElement>('[data-collection-form-fields]')!;
      const success = dialog.querySelector<HTMLElement>('[data-collection-success]')!;
      const summary = success.querySelector<HTMLElement>('[data-collection-created-summary]')!;
      const route = success.querySelector<HTMLAnchorElement>('[data-collection-created-route]')!;
      formFields.hidden = true;
      success.hidden = false;
      dialog.querySelector<HTMLButtonElement>('[data-action="create-collection-entry"]')!.hidden = true;
      summary.textContent = body.route
        ? `Created ${body.file}. Open the rendered entry to continue editing it.`
        : body.routeGuidance
          ? `Created ${body.file}. ${body.routeGuidance}`
          : `Created ${body.file}. No matching src/pages/${collection.name}/[slug].astro route was found. Open or add that route to render this entry.`;
      if (body.route) {
        route.hidden = false;
        route.href = body.route;
        route.textContent = 'Open new entry';
        route.focus();
      } else {
        route.hidden = true;
        dialog.querySelector<HTMLButtonElement>('[data-action="cancel-collection-entry"]')!.focus();
      }
      setCollectionEntryMessage(`Entry created at ${body.file}.`);
      setStatus('Collection entry created');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = error instanceof Error ? error.message : 'The collection entry could not be created.';
      setCollectionEntryMessage(message);
      setStatus(message, true);
    } finally {
      setCollectionEntryBusy(false);
    }
  }

  function onToolbarClick(event: Event): void {
    const button = event.composedPath().find(
      (item): item is HTMLButtonElement => item instanceof HTMLButtonElement,
    );
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'create-collection-entry') {
      void createCollectionEntry();
      return;
    }
    if (action === 'cancel-collection-entry') {
      closeCollectionEntryEditor();
      return;
    }
    if (action === 'save-frontmatter') {
      void saveFrontmatter();
      return;
    }
    if (action === 'cancel-frontmatter') {
      closeFrontmatterEditor(true);
      return;
    }
    if (action === 'cancel-image') {
      closeImageEditor(true);
      return;
    }
    if (action === 'upload-image') {
      void uploadImage();
      return;
    }
    if (action === 'insert-image') {
      void applyImage();
      return;
    }
    if (action === 'cancel-video') {
      closeVideoEditor(true);
      return;
    }
    if (action === 'upload-video') {
      void uploadVideo();
      return;
    }
    if (action === 'preview-video') {
      void previewExistingVideo();
      return;
    }
    if (action === 'insert-video') {
      void insertVideo();
      return;
    }
    if (action === 'cancel-iframe') {
      closeIframeEditor(true);
      return;
    }
    if (action === 'preview-iframe') {
      void previewIframe();
      return;
    }
    if (action === 'apply-iframe') {
      void applyIframe();
      return;
    }
    if (!active) return;
    if (action === 'toggle-text-style') {
      toggleMenu('text-style-menu');
      return;
    }
    if (action === 'toggle-insert') {
      toggleMenu('insert-menu');
      return;
    }
    if (action === 'toggle-replace-content') {
      toggleMenu('replace-content-menu');
      return;
    }
    const command = button.dataset.command;
    const tag = button.dataset.tag;
    const list = button.dataset.list;
    if (command) runInlineCommand(command);
    else if (tag) changeBlockTag(tag);
    else if (list === 'ul' || list === 'ol') changeList(list);
    else if (action === 'undo') undoEdit();
    else if (action === 'add-block') void addBlockAfter();
    else if (action === 'insert-content') {
      closeOpenMenus(true);
      void applyContentBlock(button.dataset.contentType as ContentBlockId, 'insert-content-after');
      return;
    } else if (action === 'replace-content') {
      closeOpenMenus(true);
      void applyContentBlock(button.dataset.contentType as ContentBlockId, 'replace-content');
      return;
    }
    else if (action === 'open-image') {
      openImageEditor('insert');
      return;
    } else if (action === 'replace-image') {
      openImageEditor('replace');
      return;
    } else if (action === 'open-video') {
      openVideoEditor();
      return;
    } else if (action === 'replace-video') {
      openVideoEditor('replace');
      return;
    } else if (action === 'open-iframe') {
      openIframeEditor();
      return;
    } else if (action === 'replace-iframe') {
      openIframeEditor('replace');
      return;
    } else if (action === 'delete-block') void deleteBlock();
    else if (action === 'link') openLinkEditor();
    else if (action === 'apply-link') applyLink();
    else if (action === 'remove-link') removeLink();
    else if (action === 'cancel-link') closeLinkEditor(true);
    else if (action === 'save') queueSave(active);
    /* istanbul ignore else -- Remaining toolbar actions are inert by design. */
    else if (action === 'done') void finishEditing();
    if (button.closest('[role="menu"]')) closeMenu(button.closest<HTMLElement>('[role="menu"]')!, true);
  }

  async function structuralTarget(): Promise<{ element: HTMLElement; marker: string } | undefined> {
    /* istanbul ignore next -- Toolbar actions require an active block. */
    if (!active) return undefined;
    let element = active;
    if (hasUnsavedChanges(element)) {
      const saved = await queueSave(element);
      /* istanbul ignore else -- Both save outcomes are covered through the caller-visible status. */
      if (!saved) return undefined;
      /* istanbul ignore next -- Saving an active structural target does not clear it. */
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

  function contentValue(element: HTMLElement): ContentBlockValue {
    const type = contentBlockTypeFromTag(element.localName);
    /* istanbul ignore next -- The replace picker is shown only for registered static blocks. */
    if (!type) return { text: '', items: [] };
    if (type.id === 'divider') return { text: '', items: [] };
    if (type.id === 'bulleted-list' || type.id === 'numbered-list') {
      return {
        text: '',
        items: [...element.querySelectorAll<HTMLElement>(':scope > li')]
          .map((item) => item.textContent!.trim())
          .filter(Boolean),
      };
    }
    return { text: element.textContent!.trim(), items: [] };
  }

  function hasInlineFormatting(element: HTMLElement): boolean {
    if (/^h[1-6]$/.test(element.localName) || element.localName === 'p') {
      return Boolean(element.querySelector(':scope > :not(br)'));
    }
    if (element.localName === 'ul' || element.localName === 'ol') {
      return Boolean(element.querySelector(':scope > li > *'));
    }
    if (element.localName === 'blockquote') return Boolean(element.querySelector(':scope > p > *'));
    return false;
  }

  function appendTextLines(element: HTMLElement, text: string): void {
    text.split('\n').forEach((line, index) => {
      if (index) element.append(document.createElement('br'));
      element.append(document.createTextNode(line));
    });
  }

  function createContentElement(typeId: ContentBlockId, value: ContentBlockValue, headingLevel = 2): HTMLElement {
    const type = contentBlockType(typeId);
    const tag = typeId === 'heading' ? `h${headingLevel}` : type.tag;
    const element = document.createElement(tag);
    if (typeId === 'divider') return element;
    if (typeId === 'bulleted-list' || typeId === 'numbered-list') {
      for (const text of value.items) {
        const item = document.createElement('li');
        item.textContent = text;
        element.append(item);
      }
      return element;
    }
    if (typeId === 'blockquote') {
      const paragraph = document.createElement('p');
      appendTextLines(paragraph, value.text);
      element.append(paragraph);
      return element;
    }
    if (typeId === 'code-block') {
      const code = document.createElement('code');
      code.textContent = value.text;
      element.append(code);
      return element;
    }
    appendTextLines(element, value.text.replace(/\s*\n\s*/g, typeId === 'heading' ? ' ' : '\n'));
    return element;
  }

  async function applyContentBlock(
    typeId: ContentBlockId,
    operation: 'insert-content-after' | 'replace-content',
    restoredValue?: ContentBlockValue,
    restoring = false,
    restoredHeadingLevel?: number,
    restoredHtml?: string,
    restoredCodeLanguage?: string,
  ): Promise<void> {
    const target = await structuralTarget();
    if (!target) return;
    const replacing = operation === 'replace-content';
    const sourceType = contentBlockTypeFromTag(target.element.localName);
    /* istanbul ignore next -- The replace picker is shown only for registered static blocks. */
    if (replacing && !sourceType) {
      setStatus('This source block cannot be replaced safely.', true);
      return;
    }
    const replacementValue = replacing && sourceType?.id !== 'divider'
      ? contentValue(target.element)
      : undefined;
    const value = normalizeContentBlockValue(typeId, restoredValue ?? replacementValue);
    const warning = replacing && sourceType
      ? replacementWarning(sourceType.id, typeId, value, hasInlineFormatting(target.element), target.element.textContent!.trim().length > 0)
      : undefined;
    if (warning && !restoring && !window.confirm(`${warning}\n\nContinue with this replacement?`)) {
      setStatus('Block replacement cancelled');
      return;
    }
    const previousUndo = contentUndo;
    const sourceHeadingLevel = /^h([1-6])$/.exec(target.element.localName)?.[1];
    const sourceCodeLanguage = target.element.localName === 'pre'
      ? target.element.dataset.language
        ?? /(?:^|\s)language-([^\s]+)/.exec(target.element.querySelector('code')!.className)?.[1]
      : undefined;
    const nextUndo: ContentUndo = replacing
      ? {
        kind: 'replace',
        type: sourceType!.id,
        value: contentValue(target.element),
        html: target.element.innerHTML,
        headingLevel: sourceHeadingLevel ? Number(sourceHeadingLevel) : undefined,
        codeLanguage: sourceCodeLanguage,
      }
      : { kind: 'delete' };
    setStatus(replacing ? 'Replacing block...' : 'Adding block...');
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marker: target.marker,
          operation,
          type: typeId,
          value,
          confirmedLoss: restoring || Boolean(warning),
          headingLevel: restoredHeadingLevel,
          html: restoredHtml,
          codeLanguage: restoredCodeLanguage,
        }),
      });
      const body = await response.json() as SaveResponse;
      /* istanbul ignore next -- The endpoint always supplies an error for rejected requests. */
      if (!response.ok || !body.marker) throw new Error(body.error ?? 'The content block could not be saved.');
      const element = createContentElement(typeId, value, restoredHeadingLevel);
      if (restoredHtml !== undefined && typeId !== 'divider') element.innerHTML = restoredHtml;
      element.setAttribute(MARKER_ATTRIBUTE, body.marker);
      if (target.element.isConnected) {
        if (replacing) target.element.replaceWith(element);
        else target.element.after(element);
        active = null;
        await activate(element);
        contentUndo = restoring ? undefined : nextUndo;
        undoHistory = [snapshot(element)];
        rememberActiveSession();
        updateUndoButton();
      } else {
        /* istanbul ignore next -- A detached undo replacement cannot retain another undo step. */
        contentUndo = restoring ? undefined : nextUndo;
        rememberInsertedBlock(body.marker, snapshot(element), contentUndo);
        active = null;
        await restoreActiveSession();
      }
      setStatus(restoring ? 'Block restored' : replacing ? 'Block replaced' : 'Block added');
    } catch (error) {
      contentUndo = previousUndo;
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      setStatus(error instanceof Error ? error.message : 'The content block could not be saved.', true);
    }
  }

  async function undoContentBlock(): Promise<void> {
    /* istanbul ignore next -- Undo is enabled only with an active structured undo step. */
    if (!active || !contentUndo) return;
    const undo = contentUndo;
    if (undo.kind === 'replace') {
      await applyContentBlock(
        undo.type, 'replace-content', undo.value, true, undo.headingLevel, undo.html, undo.codeLanguage,
      );
      return;
    }
    const target = await structuralTarget();
    /* istanbul ignore next -- A structured undo is created only for a marker-backed active block. */
    if (!target) return;
    setStatus('Removing inserted block...');
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marker: target.marker, operation: 'delete' }),
      });
      const body = await response.json() as SaveResponse;
      /* istanbul ignore next -- The endpoint always supplies an error for rejected requests. */
      if (!response.ok) throw new Error(body.error ?? 'The inserted block could not be removed.');
      if (target.element.isConnected) target.element.remove();
      active = null;
      contentUndo = undefined;
      undoHistory = [];
      toolbar.hidden = true;
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Undo still completes without storage. */ }
      setStatus('Inserted block removed');
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      setStatus(error instanceof Error ? error.message : 'The inserted block could not be removed.', true);
    }
  }

  async function addBlockAfter(): Promise<void> {
    await applyContentBlock('paragraph', 'insert-content-after');
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
      /* istanbul ignore next -- The endpoint always supplies an error for rejected requests. */
      if (!response.ok) throw new Error(body.error ?? 'The block could not be deleted.');
      /* istanbul ignore else -- Successful writes normally retain the selected DOM node until removal. */
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
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      setStatus(error instanceof Error ? error.message : 'The block could not be deleted.', true);
    }
  }

  function rememberInsertedBlock(token: string, inserted: EditSnapshot, insertedUndo?: ContentUndo): void {
    const marker = decodeClientMarker(token);
    /* istanbul ignore next -- Successful insert responses contain a server-validated marker. */
    if (!marker) return;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        pathname: location.pathname,
        file: marker.file,
        start: marker.start,
        html: inserted.html,
        tag: inserted.tag,
        history: [inserted],
        suppressAutosave: true,
        contentUndo: insertedUndo,
      } satisfies ActiveSession));
    } catch {
      // The inserted block still exists in source when session storage is unavailable.
    }
  }

  function updateStructureButtons(): void {
    /* istanbul ignore next -- This refresh is called after active-block guards. */
    const marker = decodeClientMarker(active?.getAttribute(MARKER_ATTRIBUTE) ?? null);
    const disabled = !marker || marker.format === 'frontmatter';
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>(
      '[data-action="toggle-insert"], [data-action="toggle-replace-content"], [data-action="add-block"], [data-action="insert-content"], [data-action="delete-block"]',
    )) {
      button.disabled = disabled;
    }
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-action="insert-content"]')) {
      const type = CONTENT_BLOCK_TYPES.find(({ id }) => id === button.dataset.contentType);
      const supported = marker?.format !== 'frontmatter' && Boolean(type?.contexts.includes(marker?.format as 'astro' | 'markdown'));
      button.hidden = !supported;
      button.disabled = !supported;
    }
    const activeContentType = contentBlockTypeFromTag(active!.localName);
    const replaceContent = toolbar.querySelector<HTMLButtonElement>('[data-action="toggle-replace-content"]')!;
    const canReplaceContent = !disabled && Boolean(activeContentType);
    replaceContent.hidden = !canReplaceContent;
    replaceContent.disabled = !canReplaceContent;
    for (const item of toolbar.querySelectorAll<HTMLButtonElement>('[data-action="replace-content"]')) {
      const current = item.dataset.contentType === activeContentType?.id;
      item.hidden = current;
      item.disabled = disabled || current;
    }
    const replace = toolbar.querySelector<HTMLButtonElement>('[data-action="replace-image"]')!;
    const canReplace = !disabled && !isVideoBlock(active) && active?.querySelectorAll('img').length === 1;
    replace.hidden = !canReplace;
    replace.disabled = !canReplace;
    const replaceVideo = toolbar.querySelector<HTMLButtonElement>('[data-action="replace-video"]')!;
    const canReplaceVideo = !disabled && isVideoBlock(active);
    replaceVideo.hidden = !canReplaceVideo;
    replaceVideo.disabled = !canReplaceVideo;
    const replaceIframe = toolbar.querySelector<HTMLButtonElement>('[data-action="replace-iframe"]')!;
    const canReplaceIframe = !disabled && isIframeBlock(active);
    replaceIframe.hidden = !canReplaceIframe;
    replaceIframe.disabled = !canReplaceIframe;
    /* istanbul ignore next -- Reinitializes defensively if a focused structural action becomes unavailable. */
    if (lastToolbarControl?.disabled) initializeToolbarFocus();
  }

  function updateControlStates(): void {
    const tag = active?.localName ?? 'p';
    const media = isVideoBlock(active) || isIframeBlock(active) || isStructuredStaticBlock(active);
    for (const control of toolbar.querySelectorAll<HTMLButtonElement>(
      '[data-command], [data-tag], [data-list], [data-action="toggle-text-style"], [data-action="link"], [data-action="save"], [data-action="undo"]',
    )) {
      if (control.dataset.action === 'undo' && !media) updateUndoButton();
      else control.disabled = media;
    }
    const labels: Record<string, string> = {
      p: 'Paragraph', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3',
      h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', ul: 'Paragraph', ol: 'Paragraph',
    };
    const style = labels[tag] ?? 'Paragraph';
    const styleButton = toolbar.querySelector<HTMLButtonElement>('[data-action="toggle-text-style"]');
    const styleLabel = styleButton?.querySelector<HTMLElement>('.style-label');
    /* istanbul ignore else -- The current style label is static toolbar markup. */
    if (styleLabel) styleLabel.textContent = style;
    styleButton?.setAttribute('aria-label', `Text style: ${style}`);

    const pressed = (selector: string, value: boolean): void => {
      toolbar.querySelector<HTMLButtonElement>(selector)?.setAttribute('aria-pressed', String(value));
    };
    let bold = false;
    let italic = false;
    try {
      bold = Boolean(active && document.queryCommandState('bold'));
      italic = Boolean(active && document.queryCommandState('italic'));
    } catch {
      // Browsers without queryCommandState still expose the controls as unpressed.
    }
    pressed('[data-command="bold"]', bold);
    pressed('[data-command="italic"]', italic);
    pressed('[data-list="ul"]', tag === 'ul');
    pressed('[data-list="ol"]', tag === 'ol');
  }

  function findFrontmatterContextMarker(): string | undefined {
    const candidates = [
      active,
      ...document.querySelectorAll<HTMLElement>(`[${MARKER_ATTRIBUTE}]`),
    ];
    for (const element of candidates) {
      const token = element?.getAttribute(MARKER_ATTRIBUTE);
      const marker = decodeClientMarker(token ?? null);
      if (token && marker && /\.(?:md|mdx)$/i.test(marker.file)) return token;
    }
    return undefined;
  }

  function isFrontmatterEditorOpen(): boolean {
    /* istanbul ignore next -- The dialog is static toolbar markup. */
    return shadow.querySelector<HTMLDialogElement>('.frontmatter-editor')?.open ?? false;
  }

  async function restoreFrontmatterDraft(): Promise<void> {
    const draft = readFrontmatterDraft();
    if (draft) await openFrontmatterEditor(draft);
  }

  function readFrontmatterDraft(): FrontmatterDraft | undefined {
    try {
      const value = JSON.parse(sessionStorage.getItem(FRONTMATTER_DRAFT_KEY) ?? 'null') as unknown;
      if (!value || typeof value !== 'object') return undefined;
      const draft = value as Record<string, unknown>;
      if (draft.pathname !== location.pathname || typeof draft.contextMarker !== 'string') return undefined;
      if (!draft.changes || typeof draft.changes !== 'object' || Array.isArray(draft.changes)) return undefined;
      for (const change of Object.values(draft.changes)) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) return undefined;
        const fields = change as Record<string, unknown>;
        if (typeof fields.original !== 'string'
          || (typeof fields.value !== 'string' && typeof fields.value !== 'boolean')) return undefined;
      }
      return draft as unknown as FrontmatterDraft;
    } catch {
      return undefined;
    }
  }

  async function openFrontmatterEditor(
    draft?: FrontmatterDraft,
    contextMarker?: string,
    preferredField?: string,
  ): Promise<void> {
    if (isLinkEditorOpen()) closeLinkEditor();
    const marker = draft?.contextMarker ?? contextMarker ?? findFrontmatterContextMarker();
    const editor = shadow.querySelector<HTMLDialogElement>('.frontmatter-editor');
    const fields = shadow.querySelector<HTMLElement>('.frontmatter-fields');
    /* istanbul ignore next -- These controls are static frontmatter-editor markup. */
    if (!editor || !fields) return;
    frontmatterContext = marker;
    frontmatterFields = [];
    /* istanbul ignore else -- Opening an already-open editor only refreshes its context. */
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
      /* istanbul ignore next -- The endpoint always supplies an error for rejected requests. */
      if (!response.ok || !body.fields) throw new Error(body.error ?? 'Frontmatter could not be loaded.');
      frontmatterFields = body.fields;
      renderFrontmatterFields(fields, frontmatterFields);
      if (draft) restoreFrontmatterDraftFields(draft);
      else {
        /* istanbul ignore next -- Empty field collections are a valid endpoint fallback. */
        setFrontmatterMessage(frontmatterFields.length ? '' : 'No simple frontmatter fields were found.');
      }
      const preferredInput = preferredField
        ? fields.querySelector<HTMLInputElement>(
          `[data-frontmatter-field="${CSS.escape(preferredField)}"]`,
        )
        : undefined;
      (preferredInput ?? fields.querySelector<HTMLInputElement>('input'))?.focus();
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
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
        /* istanbul ignore next -- Field-type parsing is exhaustively covered by frontmatter unit tests. */
        input.type = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text';
        input.value = String(field.value);
      }
      label.append(name, input);
      container.append(label);
    }
  }

  function restoreFrontmatterDraftFields(draft: FrontmatterDraft): void {
    let restored = false;
    for (const field of frontmatterFields) {
      const change = draft.changes[field.name];
      if (!change) continue;
      const input = shadow.querySelector<HTMLInputElement>(
        `[data-frontmatter-field="${CSS.escape(field.name)}"]`,
      );
      /* istanbul ignore next -- Inputs are rendered from this same field collection. */
      if (!input) continue;
      if (field.type === 'boolean' && typeof change.value === 'boolean') input.checked = change.value;
      else if (field.type !== 'boolean' && typeof change.value === 'string') input.value = change.value;
      else continue;
      field.original = change.original;
      restored = true;
    }
    setFrontmatterMessage(restored
      ? 'Restored unsaved frontmatter changes.'
      : 'The unsaved frontmatter fields are no longer available.');
  }

  function collectFrontmatterChanges(): Record<string, FrontmatterChangeRequest> {
    const changes: Record<string, FrontmatterChangeRequest> = {};
    for (const field of frontmatterFields) {
      const input = shadow.querySelector<HTMLInputElement>(
        `[data-frontmatter-field="${CSS.escape(field.name)}"]`,
      );
      /* istanbul ignore next -- Inputs are rendered from this same field collection. */
      if (!input) continue;
      const value = field.type === 'boolean' ? input.checked : input.value;
      if (value !== field.value) changes[field.name] = { value, original: field.original };
    }
    return changes;
  }

  function rememberFrontmatterDraft(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)
      || !event.target.hasAttribute('data-frontmatter-field')
      || !frontmatterContext) return;
    const changes = collectFrontmatterChanges();
    try {
      if (Object.keys(changes).length === 0) sessionStorage.removeItem(FRONTMATTER_DRAFT_KEY);
      else sessionStorage.setItem(FRONTMATTER_DRAFT_KEY, JSON.stringify({
        pathname: location.pathname,
        contextMarker: frontmatterContext,
        changes,
      } satisfies FrontmatterDraft));
    } catch {
      // Frontmatter editing still works when session storage is unavailable.
    }
  }

  async function saveFrontmatter(): Promise<void> {
    /* istanbul ignore next -- The save action is only rendered with a frontmatter context. */
    if (!frontmatterContext) return;
    const changes = collectFrontmatterChanges();
    if (Object.keys(changes).length === 0) {
      closeFrontmatterEditor(true);
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
          changes,
        }),
      });
      const body = await response.json() as { saved?: boolean; error?: string };
      /* istanbul ignore next -- The endpoint always supplies an error for rejected requests. */
      if (!response.ok || !body.saved) throw new Error(body.error ?? 'Frontmatter could not be saved.');
      setStatus('Saved');
      closeFrontmatterEditor(true);
    } catch (error) {
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      setFrontmatterMessage(error instanceof Error ? error.message : 'Frontmatter could not be saved.');
    }
  }

  function closeFrontmatterEditor(discardDraft = false): void {
    const editor = shadow.querySelector<HTMLDialogElement>('.frontmatter-editor');
    /* istanbul ignore else -- Close is called for an open static dialog or as an idempotent cleanup. */
    if (editor?.open) editor.close();
    frontmatterContext = undefined;
    frontmatterFields = [];
    if (discardDraft) {
      try {
        sessionStorage.removeItem(FRONTMATTER_DRAFT_KEY);
      } catch {
        // The dialog still closes when session storage is unavailable.
      }
    }
    setFrontmatterMessage('');
    active?.focus({ preventScroll: true });
  }

  function setFrontmatterMessage(message: string): void {
    const element = shadow.querySelector<HTMLElement>('.frontmatter-message');
    /* istanbul ignore else -- The message node is static frontmatter-editor markup. */
    if (element) element.textContent = message;
  }

  function isLinkEditorOpen(): boolean {
    const editor = toolbar.querySelector<HTMLElement>('.link-editor');
    return Boolean(editor && !editor.hidden);
  }

  function openLinkEditor(): void {
    /* istanbul ignore next -- Link actions require an active block. */
    if (!active) return;
    closeOpenMenus(false);
    hideOpenTooltip();
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
    /* istanbul ignore next -- A validated range is contained by the active block. */
    if (editingLink && !active.contains(editingLink)) editingLink = undefined;

    const editor = toolbar.querySelector<HTMLElement>('.link-editor');
    const input = toolbar.querySelector<HTMLInputElement>('.link-editor input');
    const remove = toolbar.querySelector<HTMLButtonElement>('[data-action="remove-link"]');
    /* istanbul ignore next -- These controls are static toolbar markup. */
    if (!editor || !input || !remove) return;
    editor.hidden = false;
    toolbar.querySelector<HTMLButtonElement>('[data-action="link"]')?.setAttribute('aria-expanded', 'true');
    input.value = editingLink?.getAttribute('href') ?? '';
    remove.disabled = !editingLink;
    setLinkError('');
    positionToolbar();
    const trigger = toolbar.querySelector<HTMLButtonElement>('[data-action="link"]');
    /* istanbul ignore else -- The link trigger is static toolbar markup. */
    if (trigger) positionSurface(editor, trigger);
    input.focus();
    input.select();
  }

  function applyLink(): void {
    /* istanbul ignore next -- Apply is only enabled by an active link-editing session. */
    if (!active || !linkRange) return;
    const input = toolbar.querySelector<HTMLInputElement>('.link-editor input');
    /* istanbul ignore next -- The input is static link-editor markup. */
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
    /* istanbul ignore next -- Remove is only enabled for the connected link in the active block. */
    if (!active || !editingLink?.isConnected || !active.contains(editingLink)) return;
    checkpoint(active);
    editingLink.replaceWith(...editingLink.childNodes);
    finishLinkChange();
  }

  function finishLinkChange(): void {
    /* istanbul ignore next -- Link changes can only finish in the active block. */
    if (!active) return;
    closeLinkEditor();
    setStatus('Unsaved');
    rememberActiveSession();
    updateUndoButton();
    window.clearTimeout(saveTimer);
    /* istanbul ignore else -- Manual-save link changes remain unsaved until an explicit save. */
    if (preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
  }

  function closeLinkEditor(restoreTrigger = false): void {
    const editor = toolbar.querySelector<HTMLElement>('.link-editor');
    const trigger = toolbar.querySelector<HTMLButtonElement>('[data-action="link"]');
    /* istanbul ignore else -- The link editor is static toolbar markup. */
    if (editor) editor.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    linkRange = undefined;
    editingLink = undefined;
    setLinkError('');
    if (restoreTrigger && trigger) {
      setRovingControl(trigger);
      trigger.focus({ preventScroll: true });
    } else {
      active?.focus({ preventScroll: true });
    }
    positionToolbar();
  }

  function restoreLinkRange(): void {
    /* istanbul ignore next -- This helper is called only after a link range is validated. */
    if (!linkRange) return;
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(linkRange);
  }

  function setLinkError(message: string): void {
    const error = toolbar.querySelector<HTMLElement>('.link-error');
    /* istanbul ignore else -- The error node is static link-editor markup. */
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
    /* istanbul ignore next -- Undo is static toolbar markup. */
    if (!button) return;
    const current = active ? snapshot(active) : undefined;
    button.disabled = !current || (!contentUndo && undoHistory.length === 1 && sameSnapshot(undoHistory[0], current));
  }

  function undoEdit(): void {
    /* istanbul ignore next -- Undo is disabled without an active checkpoint. */
    if (!active || undoHistory.length === 0) return;
    if (contentUndo) {
      void undoContentBlock();
      return;
    }
    const current = snapshot(active);
    if (undoHistory.length > 1 && sameSnapshot(undoHistory.at(-1)!, current)) undoHistory.pop();
    const target = undoHistory.at(-1);
    if (!target || sameSnapshot(target, current)) return;
    if (active.localName !== target.tag) changeBlockTag(target.tag, false, false);
    /* istanbul ignore next -- Tag replacement always installs the replacement as active. */
    if (!active) return;
    active.innerHTML = target.html;
    active.focus({ preventScroll: true });
    setCaretOffset(active);
    setStatus('Unsaved');
    rememberActiveSession();
    updateUndoButton();
    updateControlStates();
    queueSave(active);
  }

  function runInlineCommand(command: string): void {
    /* istanbul ignore next -- Formatting actions require an active block. */
    if (!active) return;
    checkpoint(active);
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false);
    active.focus({ preventScroll: true });
    setStatus('Unsaved');
    window.clearTimeout(saveTimer);
    rememberActiveSession();
    updateUndoButton();
    updateControlStates();
    if (preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
  }

  function changeList(tag: 'ul' | 'ol'): void {
    /* istanbul ignore next -- List actions require an active block. */
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
    /* istanbul ignore next -- Replacements are created only for an active block. */
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
    updateControlStates();
    if (scheduleSave && preferences.autosave) {
      const edited = active;
      saveTimer = window.setTimeout(() => queueSave(edited), options.saveDelay);
    }
    positionToolbar();
  }

  async function finishEditing(): Promise<void> {
    /* istanbul ignore next -- Finish is exposed only while a block is active. */
    if (!active) return;
    if (isFrontmatterEditorOpen()) closeFrontmatterEditor();
    if (isImageEditorOpen()) closeImageEditor();
    if (isVideoEditorOpen()) closeVideoEditor();
    if (isIframeEditorOpen()) closeIframeEditor();
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
    updateControlStates();
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
    /* istanbul ignore else -- Saves are queued while their source block is active. */
    if (element === active) {
      activeSaveInFlight = true;
      suppressRestoredAutosave = false;
      rememberActiveSession();
    }
    const html = element.innerHTML;
    /* istanbul ignore next -- HTMLElement textContent is present for supported blocks. */
    const text = element.textContent ?? '';
    const tag = element.localName;
    setStatus('Saving...');
    const pending = pendingSaves.find((save) => save.element === element);
    if (pending) {
      pending.html = html;
      pending.text = text;
      pending.tag = tag;
      return pending.promise;
    }

    let resolve!: (saved: boolean) => void;
    const promise = new Promise<boolean>((complete) => { resolve = complete; });
    pendingSaves.push({ element, html, promise, resolve, tag, text });
    void drainSaveQueue();
    return promise;
  }

  async function drainSaveQueue(): Promise<void> {
    if (saveInFlight) return;
    saveInFlight = true;
    try {
      while (pendingSaves.length) {
        const save = pendingSaves.shift()!;
        save.resolve(await saveSnapshot(save));
      }
    } finally {
      saveInFlight = false;
    }
  }

  async function saveSnapshot({ element, html, tag, text }: QueuedSave): Promise<boolean> {
    const marker = element.getAttribute(MARKER_ATTRIBUTE);
    if (!marker) {
      /* istanbul ignore else -- Missing markers are detected on the current active block. */
      if (element === active) {
        activeSaveInFlight = hasPendingSave(element);
        rememberActiveSession();
      }
      setStatus('Missing source marker.', true);
      return false;
    }
    setStatus('Saving...');
    const controller = new AbortController();
    const requestTimeout = window.setTimeout(() => controller.abort(), SAVE_REQUEST_TIMEOUT);
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marker, html, text, tag }),
        signal: controller.signal,
      });
      const body = await response.json() as SaveResponse;
      /* istanbul ignore next -- The endpoint always supplies an error for rejected requests. */
      if (!response.ok || !body.marker) throw new Error(body.error ?? 'The source file could not be saved.');
      /* istanbul ignore else -- Unchanged DOM markers are refreshed from successful responses. */
      if (element.getAttribute(MARKER_ATTRIBUTE) === marker) {
        element.setAttribute(MARKER_ATTRIBUTE, body.marker);
      }
      /* istanbul ignore else -- An inactive block needs no active-session update. */
      if (element === active) {
        activeSaveInFlight = hasPendingSave(element);
        suppressRestoredAutosave = !activeSaveInFlight && sameSnapshot(snapshot(element), { html, tag });
        checkpoint(element, { html, tag });
      }
      setStatus('Saved');
      return true;
    } catch (error) {
      /* istanbul ignore else -- An inactive block needs no active-session update. */
      if (element === active) {
        activeSaveInFlight = hasPendingSave(element);
        rememberActiveSession();
      }
      /* istanbul ignore next -- Fetch and response failures are Error instances in browsers. */
      const message = controller.signal.aborted
        ? 'Saving timed out. Try again.'
        : error instanceof Error ? error.message : 'The source file could not be saved.';
      setStatus(message, true);
      return false;
    } finally {
      window.clearTimeout(requestTimeout);
    }
  }

  function hasPendingSave(element: HTMLElement): boolean {
    return pendingSaves.some((save) => save.element === element);
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
    positionOpenSurfaces();
  }

  function positionOpenSurfaces(): void {
    for (const surface of toolbar.querySelectorAll<HTMLElement>('.floating-surface:not([hidden])')) {
      const trigger = surface.getAttribute('role') === 'tooltip'
        ? toolbar.querySelector<HTMLElement>(`[data-tooltip-owner="${surface.dataset.owner}"]`)
        : toolbar.querySelector<HTMLElement>(`[aria-controls="${surface.id}"]`);
      /* istanbul ignore else -- Every static floating surface has a matching trigger while open. */
      if (trigger) positionSurface(surface, trigger, surface.getAttribute('role') === 'tooltip');
    }
  }

  function setStatus(message: string, error = false): void {
    status.textContent = message;
    status.dataset.error = String(error);
    const save = toolbar.querySelector<HTMLButtonElement>('[data-action="save"]');
    const saving = message === 'Saving...';
    /* istanbul ignore else -- Save is static toolbar markup. */
    if (save) {
      const state = error ? 'error' : saving ? 'saving' : message === 'Saved' ? 'saved' : 'idle';
      save.dataset.state = state;
      save.setAttribute('aria-busy', String(saving));
      const label = save.querySelector<HTMLElement>('[data-save-label]');
      /* istanbul ignore else -- Save label is static toolbar markup. */
      if (label) label.textContent = saving ? 'Saving' : state === 'saved' ? 'Saved' : 'Save';
    }
  }
}

function sourceLocationDistance(candidate: string | undefined, target: string): number {
  /* istanbul ignore next -- The optional candidate is covered by the invalid-coordinate guard below. */
  const parse = (value: string | undefined) => value?.split(':').map(Number) ?? [];
  const [candidateLine, candidateColumn] = parse(candidate);
  const [targetLine, targetColumn] = parse(target);
  /* istanbul ignore next -- Source locations come from Astro's numeric compiler coordinates. */
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
  original?: string;
  field?: string;
} | undefined {
  if (!token) return undefined;
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof value.file !== 'string' || typeof value.start !== 'number') return undefined;
    if (value.format !== 'astro' && value.format !== 'frontmatter' && value.format !== 'markdown') return undefined;
    return {
      file: value.file,
      start: value.start,
      format: value.format,
      original: typeof value.original === 'string' ? value.original : undefined,
      field: typeof value.field === 'string' ? value.field : undefined,
    };
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

function setCaretOffset(element: HTMLElement, offset = element.textContent!.length): void {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent!.length;
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

export function toolbarMarkup(): string {
  return `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      [role="toolbar"] {
        position: fixed; left: 0; top: 0; box-sizing: border-box; width: max-content;
        max-width: calc(100vw - 16px); padding: 6px; overflow: visible; pointer-events: auto;
        color: #f8fafc; color-scheme: dark; background: #111827; border: 1px solid #64748b;
        border-radius: 9px; box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
        font: 13px/1.25 ui-sans-serif, system-ui, sans-serif;
      }
      .toolbar-groups { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px; max-width: 100%; }
      .toolbar-group { display: flex; flex: 0 1 auto; max-width: 100%; flex-wrap: nowrap; gap: 3px; padding: 2px; border: 1px solid #475569; border-radius: 7px; }
      .toolbar-group.format, .toolbar-group.structure { flex-wrap: wrap; }
      button {
        display: inline-flex; box-sizing: border-box; min-width: 44px; min-height: 44px; align-items: center;
        justify-content: center; gap: 7px; padding: 8px 10px; color: inherit; background: #1f2937;
        border: 1px solid #64748b; border-radius: 5px; font: 600 13px/1.2 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer; touch-action: manipulation;
      }
      button.icon-only { width: 44px; padding: 8px; }
      button:hover { background: #334155; }
      button[aria-pressed="true"], button[aria-expanded="true"] { background: #0f766e; border-color: #5eead4; }
      [data-action="save"] {
        width: 96px; box-shadow: 0 2px 0 #020617;
        transition: transform 80ms ease, background-color 120ms ease, border-color 120ms ease;
      }
      [data-action="save"]:active:not(:disabled), [data-action="save"][data-state="saving"] {
        transform: translateY(2px); box-shadow: none;
      }
      [data-action="save"][data-state="saving"] { color: #dbeafe; background: #1e3a8a; border-color: #93c5fd; }
      [data-action="save"][data-state="saved"] { color: #dcfce7; background: #166534; border-color: #86efac; }
      [data-action="save"][data-state="saved"]:hover { background: #15803d; }
      @media (prefers-reduced-motion: reduce) { [data-action="save"] { transition: none; } }
      button.danger { color: #fecaca; border: 2px solid #ef4444; border-radius: 3px; }
      button.danger:hover { background: #7f1d1d; }
      button:disabled { opacity: .5; text-decoration: line-through; cursor: not-allowed; }
      button:focus, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 2px; }
      svg { display: block; flex: 0 0 20px; width: 20px; height: 20px; }
      .floating-surface {
        position: absolute; z-index: 2; box-sizing: border-box; max-width: calc(100vw - 16px);
        color: #f8fafc; background: #111827; border: 1px solid #94a3b8; border-radius: 7px;
        box-shadow: 0 8px 24px rgb(0 0 0 / 45%); pointer-events: auto;
      }
      [role="menu"] { display: grid; width: 230px; max-height: min(520px, calc(100vh - 24px)); gap: 3px; padding: 5px; overflow-y: auto; }
      [role="menu"] button { width: 100%; justify-content: flex-start; }
      [role="menu"] .shortcut { margin-left: auto; color: #cbd5e1; font-size: 12px; }
      [role="menu"] [role="separator"] { height: 1px; margin: 4px; background: #475569; }
      .picker-help { margin: 4px 7px 6px; color: #cbd5e1; font-size: 12px; line-height: 1.35; }
      [role="tooltip"] { width: max-content; max-width: min(240px, calc(100vw - 16px)); padding: 7px 9px; overflow-wrap: anywhere; }
      .link-editor { display: grid; width: min(330px, calc(100vw - 16px)); gap: 7px; padding: 10px; }
      .link-editor label { display: grid; gap: 5px; font-weight: 600; }
      .link-editor input { box-sizing: border-box; width: 100%; min-height: 44px; padding: 0 9px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .link-actions { display: flex; flex-wrap: wrap; gap: 4px; }
      .link-error { overflow-wrap: anywhere; color: #fecaca; font-size: 12px; }
      .frontmatter-editor, .image-editor, .video-editor, .iframe-editor, .collection-entry-editor { width: min(520px, calc(100vw - 32px)); max-height: min(680px, calc(100vh - 32px)); padding: 16px; overflow-y: auto; color: #f8fafc; background: #111827; border: 1px solid #475569; border-radius: 8px; box-shadow: 0 8px 28px rgb(0 0 0 / 45%); pointer-events: auto; }
      .frontmatter-editor::backdrop, .image-editor::backdrop, .video-editor::backdrop, .iframe-editor::backdrop, .collection-entry-editor::backdrop { background: rgb(15 23 42 / 65%); }
      .frontmatter-editor h2, .image-editor h2, .video-editor h2, .iframe-editor h2, .collection-entry-editor h2 { margin: 0 0 12px; font: 600 17px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .image-editor form, .image-field, .image-source-panel { display: grid; gap: 9px; }
      .image-field { gap: 5px; font-weight: 600; }
      .image-field small { color: #cbd5e1; font-weight: 400; }
      .image-field input:not([type="radio"]) { box-sizing: border-box; width: 100%; min-height: 44px; padding: 8px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .image-source-options { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 0; padding: 10px; border: 1px solid #475569; border-radius: 5px; }
      .image-source-options label { display: inline-flex; gap: 7px; min-height: 44px; align-items: center; }
      .image-preview { display: grid; gap: 5px; margin: 0; }
      .image-preview img { display: block; max-width: 100%; max-height: 220px; margin-inline: auto; object-fit: contain; border-radius: 5px; }
      .image-preview figcaption { color: #cbd5e1; font-size: 12px; }
      .image-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
      .image-message { min-height: 1.25em; overflow-wrap: anywhere; color: #fecaca; font-size: 12px; }
      .video-editor form, .video-field, .video-source-panel { display: grid; gap: 7px; }
      .video-field { font-weight: 600; }
      .video-field small { color: #cbd5e1; font-weight: 400; }
      .video-field :is(input:not([type="checkbox"]):not([type="radio"]), select, textarea) { box-sizing: border-box; width: 100%; min-height: 44px; padding: 8px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .video-source-options { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 0; padding: 10px; border: 1px solid #475569; border-radius: 5px; }
      .video-source-options label { display: inline-flex; gap: 7px; min-height: 44px; align-items: center; }
      .video-field textarea { min-height: 78px; resize: vertical; }
      .video-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 10px; margin: 0; padding: 10px; border: 1px solid #475569; border-radius: 5px; }
      .video-options label { display: inline-flex; gap: 7px; min-height: 44px; align-items: center; }
      .video-options input { width: 24px; height: 24px; }
      .video-preview { display: block; max-width: 100%; max-height: 220px; margin-inline: auto; }
      .video-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .video-message { min-height: 1.25em; overflow-wrap: anywhere; color: #fecaca; font-size: 12px; }
      .iframe-editor form, .iframe-field { display: grid; gap: 7px; }
      .iframe-field { font-weight: 600; }
      .iframe-field small, [data-iframe-origins] { color: #cbd5e1; font-weight: 400; }
      .iframe-field :is(input, select) { box-sizing: border-box; width: 100%; min-height: 44px; padding: 8px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .iframe-dimensions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .iframe-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 10px; margin: 0; padding: 10px; border: 1px solid #475569; border-radius: 5px; }
      .iframe-options label { display: inline-flex; gap: 7px; min-height: 44px; align-items: center; }
      .iframe-options input { width: 24px; height: 24px; }
      .iframe-preview { box-sizing: border-box; max-width: 100%; max-height: 260px; border: 1px solid #94a3b8; background: #fff; }
      .iframe-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      .iframe-message { min-height: 1.25em; overflow-wrap: anywhere; color: #fecaca; font-size: 12px; }
      .frontmatter-fields { display: grid; gap: 9px; }
      .frontmatter-field { display: grid; grid-template-columns: minmax(110px, .7fr) minmax(0, 1.3fr); align-items: center; gap: 10px; }
      .frontmatter-field > span { overflow-wrap: anywhere; color: #cbd5e1; }
      .frontmatter-field input:not([type="checkbox"]) { min-width: 0; min-height: 44px; padding: 0 8px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .frontmatter-field input[type="checkbox"] { width: 24px; height: 24px; }
      .frontmatter-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #475569; }
      .frontmatter-message { overflow-wrap: anywhere; color: #fecaca; font-size: 12px; }
      .collection-entry-editor form, [data-collection-form-fields], [data-collection-fields], .collection-field, [data-collection-success] { display: grid; gap: 9px; }
      .collection-field { font-weight: 600; }
      .collection-field :is(input:not([type="checkbox"]), select, textarea), .collection-entry-editor > form > [data-collection-form-fields] > label :is(input, select, textarea) { box-sizing: border-box; width: 100%; min-height: 44px; padding: 8px; color: #111827; background: #fff; border: 1px solid #94a3b8; border-radius: 5px; font: 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      .collection-field input[type="checkbox"] { width: 24px; height: 24px; }
      .collection-entry-editor textarea { min-height: 100px; resize: vertical; }
      .collection-entry-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
      .collection-entry-message { min-height: 1.25em; overflow-wrap: anywhere; color: #fecaca; font-size: 12px; }
      [data-unsupported-collections] { margin: 4px 0; padding: 10px; border: 1px solid #64748b; border-radius: 5px; color: #cbd5e1; }
      [data-unsupported-collections] h3 { margin: 0 0 6px; color: #fff; font: 600 14px/1.2 ui-sans-serif, system-ui, sans-serif; }
      [data-unsupported-collections] ul { margin: 0; padding-left: 20px; }
      [data-omitted-collection-fields] { color: #cbd5e1; font-size: 12px; }
      [data-collection-created-route] { display: inline-flex; min-height: 44px; align-items: center; width: fit-content; color: #bfdbfe; font-weight: 600; }
      [role="status"] { display: block; max-width: 100%; margin: 6px 5px 1px; overflow-wrap: anywhere; color: #bbf7d0; }
      [role="status"][data-error="true"] { color: #fecaca; }
      [hidden] { display: none !important; }
      @media (forced-colors: active) {
        [role="toolbar"], .toolbar-group, .floating-surface, button { border: 1px solid ButtonText; }
        button[aria-pressed="true"], button[aria-expanded="true"] { outline: 2px solid Highlight; }
        button.danger { border: 2px dashed ButtonText; }
        button:disabled { opacity: 1; color: GrayText; }
      }
    </style>
    <div role="toolbar" aria-label="Edit text" hidden>
      <div class="toolbar-groups">
        <div class="toolbar-group history" role="group" aria-label="History">
          <button type="button" class="icon-only" data-toolbar-item data-action="undo" data-tooltip="Undo (Ctrl/Cmd+Z)" data-tooltip-owner="undo" aria-label="Undo" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Control+Z Meta+Z" disabled>${lucideIcon('undo-2')}</button>
        </div>
        <div class="toolbar-group block-type" role="group" aria-label="Block type">
          <button type="button" data-toolbar-item data-action="toggle-text-style" aria-label="Text style: Paragraph" aria-haspopup="menu" aria-expanded="false" aria-controls="text-style-menu">${lucideIcon('type')}<span class="style-label">Paragraph</span></button>
        </div>
        <div class="toolbar-group format" role="group" aria-label="Format">
          <button type="button" class="icon-only" data-toolbar-item data-command="bold" data-tooltip="Bold (Ctrl/Cmd+B)" data-tooltip-owner="bold" aria-label="Bold" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Control+B Meta+B" aria-pressed="false">${lucideIcon('bold')}</button>
          <button type="button" class="icon-only" data-toolbar-item data-command="italic" data-tooltip="Italic (Ctrl/Cmd+I)" data-tooltip-owner="italic" aria-label="Italic" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Control+I Meta+I" aria-pressed="false">${lucideIcon('italic')}</button>
          <button type="button" class="icon-only" data-toolbar-item data-action="link" data-tooltip="Link (Ctrl/Cmd+K)" data-tooltip-owner="link" aria-label="Link" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Control+K Meta+K" aria-expanded="false" aria-controls="link-editor">${lucideIcon('link')}</button>
          <button type="button" class="icon-only" data-toolbar-item data-list="ul" data-tooltip="Bullet list (Ctrl/Cmd+Shift+8)" data-tooltip-owner="bullet-list" aria-label="Bullet list" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Control+Shift+8 Meta+Shift+8" aria-pressed="false">${lucideIcon('list')}</button>
          <button type="button" class="icon-only" data-toolbar-item data-list="ol" data-tooltip="Numbered list (Ctrl/Cmd+Shift+7)" data-tooltip-owner="numbered-list" aria-label="Numbered list" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Control+Shift+7 Meta+Shift+7" aria-pressed="false">${lucideIcon('list-ordered')}</button>
        </div>
        <div class="toolbar-group structure" role="group" aria-label="Structure">
          <button type="button" data-toolbar-item data-action="toggle-insert" aria-label="Insert" aria-haspopup="menu" aria-expanded="false" aria-controls="insert-menu">${lucideIcon('plus')}<span>Insert</span></button>
          <button type="button" data-toolbar-item data-action="toggle-replace-content" aria-label="Replace block" aria-haspopup="menu" aria-expanded="false" aria-controls="replace-content-menu" hidden disabled>${lucideIcon('type')}<span>Replace block</span></button>
          <button type="button" data-toolbar-item data-action="replace-image" aria-label="Replace image" hidden disabled>${lucideIcon('image-plus')}<span>Replace image</span></button>
          <button type="button" data-toolbar-item data-action="replace-video" aria-label="Replace video" hidden disabled>${lucideIcon('video')}<span>Replace video</span></button>
          <button type="button" data-toolbar-item data-action="replace-iframe" aria-label="Edit iframe" hidden disabled>${lucideIcon('link')}<span>Edit iframe</span></button>
          <button type="button" class="danger" data-toolbar-item data-action="delete-block" aria-label="Delete block">${lucideIcon('trash-2')}<span>Delete</span></button>
        </div>
        <div class="toolbar-group session" role="group" aria-label="Session">
          <button type="button" data-toolbar-item data-action="save" data-state="idle" data-tooltip="Save (Ctrl/Cmd+S)" data-tooltip-owner="save" aria-label="Save" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Control+S Meta+S" aria-busy="false">${lucideIcon('save')}<span data-save-label>Save</span></button>
          <button type="button" data-toolbar-item data-action="done" data-tooltip="Done (Esc)" data-tooltip-owner="done" aria-describedby="toolbar-tooltip" aria-keyshortcuts="Escape">${lucideIcon('check')}<span>Done</span></button>
        </div>
      </div>
      <div id="text-style-menu" class="floating-surface" role="menu" aria-label="Text style" hidden>
        <button type="button" role="menuitem" tabindex="-1" data-tag="p">Paragraph</button>
        <button type="button" role="menuitem" tabindex="-1" data-tag="h1">Heading 1 <span class="shortcut">Alt+1</span></button>
        <button type="button" role="menuitem" tabindex="-1" data-tag="h2">Heading 2 <span class="shortcut">Alt+2</span></button>
        <button type="button" role="menuitem" tabindex="-1" data-tag="h3">Heading 3 <span class="shortcut">Alt+3</span></button>
        <button type="button" role="menuitem" tabindex="-1" data-tag="h4">Heading 4 <span class="shortcut">Alt+4</span></button>
        <button type="button" role="menuitem" tabindex="-1" data-tag="h5">Heading 5 <span class="shortcut">Alt+5</span></button>
        <button type="button" role="menuitem" tabindex="-1" data-tag="h6">Heading 6 <span class="shortcut">Alt+6</span></button>
      </div>
      <div id="insert-menu" class="floating-surface" role="menu" aria-label="Insert" hidden>
        ${CONTENT_PICKER_ITEMS.filter((item) => item.kind === 'static').map((item) => `<button type="button" role="menuitem" tabindex="-1" data-action="${item.id === 'paragraph' ? 'add-block' : 'insert-content'}" data-content-type="${item.id}">${lucideIcon(item.icon)}<span>${item.id === 'paragraph' ? 'Paragraph below' : item.label}</span></button>`).join('')}
        <span role="separator"></span>
        ${CONTENT_PICKER_ITEMS.filter((item) => item.kind === 'dialog').map((item) => `<button type="button" role="menuitem" tabindex="-1" data-action="${item.action}">${lucideIcon(item.icon)}<span>${item.label}</span></button>`).join('')}
        <p class="picker-help">Only static source-backed blocks valid in this file are available. Dynamic expressions and components stay read-only.</p>
      </div>
      <div id="replace-content-menu" class="floating-surface" role="menu" aria-label="Replace block" hidden>
        ${CONTENT_BLOCK_TYPES.map((item) => `<button type="button" role="menuitem" tabindex="-1" data-action="replace-content" data-content-type="${item.id}">${lucideIcon(item.icon)}<span>Replace with ${item.label.toLowerCase()}</span></button>`).join('')}
        <p class="picker-help">Your text is kept. The editor asks before removing formatting or block structure.</p>
      </div>
      <section id="link-editor" class="link-editor floating-surface" role="dialog" aria-label="Edit link" hidden>
        <label for="astro-wysiwyg-link-url">Link URL<input id="astro-wysiwyg-link-url" type="text" inputmode="url" aria-describedby="link-error" placeholder="https://example.com or /page" /></label>
        <div class="link-actions">
          <button type="button" data-action="apply-link" aria-label="Apply link">Apply</button>
          <button type="button" data-action="remove-link" aria-label="Remove link">Remove</button>
          <button type="button" data-action="cancel-link" aria-label="Cancel link">Cancel</button>
        </div>
        <span id="link-error" class="link-error" role="alert"></span>
      </section>
      <span id="toolbar-tooltip" class="floating-surface" role="tooltip" hidden></span>
      <span role="status" aria-live="polite" data-error="false">Editing</span>
    </div>
    <dialog class="collection-entry-editor" aria-label="Create collection entry">
      <h2>Create collection entry</h2>
      <form>
        <div data-collection-form-fields>
          <label class="collection-field" for="astro-wysiwyg-collection">Collection<select id="astro-wysiwyg-collection" name="collection" required></select></label>
          <label class="collection-field" for="astro-wysiwyg-collection-slug">Slug or filename<input id="astro-wysiwyg-collection-slug" name="slug" type="text" maxlength="100" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required aria-describedby="collection-slug-help" /></label>
          <small id="collection-slug-help">Use lowercase letters, numbers, and single hyphens. Existing entries are never overwritten.</small>
          <div data-collection-fields></div>
          <small data-omitted-collection-fields></small>
          <label class="collection-field" for="astro-wysiwyg-collection-body">Starter body<textarea id="astro-wysiwyg-collection-body" name="body" maxlength="100000" required>Start writing here.</textarea></label>
          <div data-unsupported-collections hidden></div>
        </div>
        <div data-collection-success hidden>
          <p data-collection-created-summary></p>
          <a data-collection-created-route hidden></a>
        </div>
        <div class="collection-entry-actions">
          <button type="button" data-action="create-collection-entry">Create entry</button>
          <button type="button" data-action="cancel-collection-entry">Cancel</button>
        </div>
        <span class="collection-entry-message" role="alert" aria-live="polite"></span>
      </form>
    </dialog>
    <dialog class="frontmatter-editor" aria-label="Edit frontmatter">
      <h2>Frontmatter</h2>
      <div class="frontmatter-fields"></div>
      <div class="frontmatter-actions">
        <button type="button" data-action="save-frontmatter">Save frontmatter</button>
        <button type="button" data-action="cancel-frontmatter">Cancel</button>
        <span class="frontmatter-message" role="alert"></span>
      </div>
    </dialog>
    <dialog class="image-editor" aria-label="Insert image">
      <h2>Insert image</h2>
      <form>
        <fieldset class="image-source-options" hidden>
          <legend>Replacement source</legend>
          <label><input name="image-source" type="radio" value="upload" checked /> Upload new image</label>
          <label><input name="image-source" type="radio" value="existing" disabled /> Existing project asset</label>
        </fieldset>
        <div class="image-source-panel" data-image-source-panel="upload">
          <div class="image-field">
            <label for="astro-wysiwyg-image-file">Image file</label>
            <input id="astro-wysiwyg-image-file" name="image-file" type="file" accept=".png,.jpg,.jpeg,.gif,.webp" required aria-describedby="image-file-help" />
            <small id="image-file-help">PNG, JPEG, GIF, or WebP, up to 5 MB.</small>
          </div>
          <div class="image-field">
            <label for="astro-wysiwyg-image-destination">Destination name</label>
            <input id="astro-wysiwyg-image-destination" name="destination" type="text" maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" required aria-describedby="image-destination-help" />
            <small id="image-destination-help">Stored in the configured public image directory.</small>
          </div>
        </div>
        <div class="image-source-panel" data-image-source-panel="existing" hidden>
          <div class="image-field">
            <label for="astro-wysiwyg-image-existing">Project asset reference</label>
            <input id="astro-wysiwyg-image-existing" name="existing-reference" type="text" maxlength="1000" placeholder="/assets/photo.png or ../assets/photo.png" required disabled aria-describedby="image-existing-help" />
            <small id="image-existing-help">Use a public URL path or a path relative to this source file.</small>
          </div>
        </div>
        <div class="image-field">
          <label for="astro-wysiwyg-image-alt">Alt text</label>
          <input id="astro-wysiwyg-image-alt" name="alt" type="text" maxlength="300" required aria-describedby="image-alt-help" />
          <small id="image-alt-help">Describe the image's purpose for people who cannot see it.</small>
        </div>
        <figure class="image-preview" hidden>
          <img data-image-preview alt="Replacement preview" />
          <figcaption>Preview of the image that will be used.</figcaption>
        </figure>
        <div class="image-actions">
          <button type="button" data-action="upload-image" aria-busy="false">Upload image</button>
          <button type="button" data-action="insert-image" aria-busy="false" disabled>Insert image</button>
          <button type="button" data-action="cancel-image">Cancel</button>
        </div>
        <span class="image-message" role="alert" aria-live="polite"></span>
      </form>
    </dialog>
    <dialog class="video-editor" aria-label="Insert video">
      <h2>Insert video</h2>
      <form>
        <fieldset class="video-source-options" hidden>
          <legend>Replacement source</legend>
          <label><input name="video-source" type="radio" value="upload" checked /> Upload new video</label>
          <label><input name="video-source" type="radio" value="existing" disabled /> Existing public video</label>
        </fieldset>
        <div class="video-source-panel" data-video-source-panel="upload">
          <div class="video-field">
            <label for="astro-wysiwyg-video-file">Video file</label>
            <input id="astro-wysiwyg-video-file" name="video-file" type="file" accept="${VIDEO_ACCEPT}" required aria-describedby="video-file-help" />
            <small id="video-file-help">H.264 MP4, up to 100 MB.</small>
          </div>
          <div class="video-field">
            <label for="astro-wysiwyg-video-destination">Destination name</label>
            <input id="astro-wysiwyg-video-destination" name="video-destination" type="text" maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._-]*\\.mp4" required aria-describedby="video-destination-help" />
            <small id="video-destination-help">Stored in the configured public video directory.</small>
          </div>
        </div>
        <div class="video-source-panel" data-video-source-panel="existing" hidden>
          <div class="video-field">
            <label for="astro-wysiwyg-existing-video">Public video path</label>
            <input id="astro-wysiwyg-existing-video" name="existing-video-reference" type="text" maxlength="1000" pattern="/[A-Za-z0-9._/-]+\\.mp4" placeholder="/assets/video.mp4" disabled aria-describedby="existing-video-help" />
            <small id="existing-video-help">Use an H.264 MP4 file from Astro's public directory.</small>
          </div>
        </div>
        <div class="video-field">
          <label for="astro-wysiwyg-video-label">Accessible label</label>
          <input id="astro-wysiwyg-video-label" name="video-label" type="text" maxlength="300" required aria-describedby="video-label-help" />
          <small id="video-label-help">Name the video's purpose for assistive technology.</small>
        </div>
        <div class="video-field">
          <label for="astro-wysiwyg-video-description">Visible description</label>
          <textarea id="astro-wysiwyg-video-description" name="video-description" maxlength="1000" required aria-describedby="video-description-help"></textarea>
          <small id="video-description-help">Describe the video beside the native player. Add captions in source when spoken content requires them.</small>
        </div>
        <div class="video-field">
          <label for="astro-wysiwyg-video-poster">Poster image path (optional)</label>
          <input id="astro-wysiwyg-video-poster" name="video-poster" type="text" maxlength="1000" placeholder="/assets/poster.png" aria-describedby="video-poster-help" />
          <small id="video-poster-help">Use an existing PNG, JPEG, GIF, or WebP file from Astro's public directory.</small>
        </div>
        <div class="video-field">
          <label for="astro-wysiwyg-video-preload">Preload</label>
          <select id="astro-wysiwyg-video-preload" name="video-preload">
            <option value="none">None</option>
            <option value="metadata" selected>Metadata</option>
            <option value="auto">Auto</option>
          </select>
        </div>
        <fieldset class="video-options">
          <legend>Playback</legend>
          <label><input name="video-controls" type="checkbox" required checked /> Controls</label>
          <label><input name="video-muted" type="checkbox" /> Muted</label>
          <label><input name="video-loop" type="checkbox" /> Loop</label>
          <label><input name="video-autoplay" type="checkbox" /> Autoplay</label>
        </fieldset>
        <video class="video-preview" data-video-preview controls muted aria-label="Selected video preview" hidden></video>
        <div class="video-actions">
          <button type="button" data-action="upload-video" aria-busy="false">Upload video</button>
          <button type="button" data-action="preview-video" aria-busy="false" hidden>Preview existing video</button>
          <button type="button" data-action="insert-video" aria-busy="false" disabled>Insert video</button>
          <button type="button" data-action="cancel-video">Cancel</button>
        </div>
        <span class="video-message" role="alert" aria-live="polite"></span>
      </form>
    </dialog>
    <dialog class="iframe-editor" aria-label="Insert iframe">
      <h2>Insert iframe</h2>
      <form>
        <div class="iframe-field">
          <label for="astro-wysiwyg-iframe-src">Embed URL</label>
          <input id="astro-wysiwyg-iframe-src" name="iframe-src" type="text" maxlength="2000" required placeholder="/embed-preview or https://approved.example/embed" aria-describedby="iframe-src-help iframe-origins" />
          <small id="iframe-src-help">Use a same-origin path or an exact HTTPS origin approved in Astro config.</small>
          <small id="iframe-origins" data-iframe-origins></small>
        </div>
        <div class="iframe-field">
          <label for="astro-wysiwyg-iframe-title">Accessible title</label>
          <input id="astro-wysiwyg-iframe-title" name="iframe-title" type="text" maxlength="300" required aria-describedby="iframe-title-help" />
          <small id="iframe-title-help">Name the embedded content for screen reader users.</small>
        </div>
        <div class="iframe-dimensions">
          <div class="iframe-field"><label for="astro-wysiwyg-iframe-width">Width</label><input id="astro-wysiwyg-iframe-width" name="iframe-width" type="number" min="1" max="4096" step="1" value="560" required /></div>
          <div class="iframe-field"><label for="astro-wysiwyg-iframe-height">Height</label><input id="astro-wysiwyg-iframe-height" name="iframe-height" type="number" min="1" max="4096" step="1" value="315" required /></div>
        </div>
        <div class="iframe-field">
          <label for="astro-wysiwyg-iframe-loading">Loading</label>
          <select id="astro-wysiwyg-iframe-loading" name="iframe-loading"><option value="lazy" selected>Lazy</option><option value="eager">Eager</option></select>
        </div>
        <div class="iframe-field">
          <label for="astro-wysiwyg-iframe-referrer">Referrer policy</label>
          <select id="astro-wysiwyg-iframe-referrer" name="iframe-referrer-policy">
            <option value="strict-origin-when-cross-origin">Strict origin when cross-origin</option><option value="no-referrer">No referrer</option><option value="origin">Origin</option><option value="same-origin">Same origin</option><option value="strict-origin">Strict origin</option>
          </select>
        </div>
        <fieldset class="iframe-options">
          <legend>Permissions</legend>
          <label><input name="iframe-allow" type="checkbox" value="autoplay" /> Autoplay</label>
          <label><input name="iframe-allow" type="checkbox" value="clipboard-write" /> Clipboard write</label>
          <label><input name="iframe-allow" type="checkbox" value="encrypted-media" /> Encrypted media</label>
          <label><input name="iframe-allow" type="checkbox" value="fullscreen" /> Fullscreen permission</label>
          <label><input name="iframe-allow" type="checkbox" value="picture-in-picture" /> Picture in picture</label>
          <label><input name="iframe-allow-fullscreen" type="checkbox" /> Fullscreen attribute</label>
        </fieldset>
        <fieldset class="iframe-options">
          <legend>Sandbox</legend>
          <label><input name="iframe-sandbox" type="checkbox" value="allow-forms" /> Forms</label>
          <label><input name="iframe-sandbox" type="checkbox" value="allow-modals" /> Modals</label>
          <label><input name="iframe-sandbox" type="checkbox" value="allow-popups" /> Popups</label>
          <label><input name="iframe-sandbox" type="checkbox" value="allow-presentation" /> Presentation</label>
          <label><input name="iframe-sandbox" type="checkbox" value="allow-same-origin" /> Same origin</label>
          <label><input name="iframe-sandbox" type="checkbox" value="allow-scripts" /> Scripts</label>
        </fieldset>
        <div data-iframe-preview-container></div>
        <div class="iframe-actions">
          <button type="button" data-action="preview-iframe" aria-busy="false">Preview iframe</button>
          <button type="button" data-action="apply-iframe" aria-busy="false" disabled>Insert iframe</button>
          <button type="button" data-action="cancel-iframe">Cancel</button>
        </div>
        <span class="iframe-message" role="alert" aria-live="polite"></span>
      </form>
    </dialog>
  `;
}
