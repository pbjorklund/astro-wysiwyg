import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import {
  DEFAULT_PREFERENCES,
  FRONTMATTER_EVENT,
  PREFERENCES_EVENT,
  PREFERENCES_KEY,
  readPreferences,
  updatePreferences,
} from '../src/preferences.ts';
import toolbarApp from '../src/toolbar-app.ts';

function installWindow(): Window {
  const window = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window,
    document: window.document,
    localStorage: window.localStorage,
    CustomEvent: window.CustomEvent,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
  });
  class ToolbarToggle extends window.HTMLElement {
    input = window.document.createElement('input');
    toggleStyle = '';

    constructor() {
      super();
      this.input.type = 'checkbox';
      this.append(this.input);
    }
  }
  window.customElements.define('astro-dev-toolbar-toggle', ToolbarToggle);
  return window;
}

test('reads defaults, invalid storage, and each partial preference fallback', () => {
  const window = installWindow();
  assert.deepEqual(readPreferences(), DEFAULT_PREFERENCES);
  window.localStorage.setItem(PREFERENCES_KEY, '{invalid');
  assert.deepEqual(readPreferences(), DEFAULT_PREFERENCES);
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ enabled: 'yes', autosave: 1, highlights: null }));
  assert.deepEqual(readPreferences(), DEFAULT_PREFERENCES);
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ enabled: false, autosave: false, highlights: false }));
  assert.deepEqual(readPreferences(), { enabled: false, autosave: false, highlights: false });
});

test('updates preferences and dispatches changes even when storage fails', () => {
  const window = installWindow();
  let detail: unknown;
  window.document.addEventListener(PREFERENCES_EVENT, (event) => { detail = (event as CustomEvent).detail; });
  assert.deepEqual(updatePreferences({ enabled: false }), { enabled: false, autosave: true, highlights: true });
  assert.deepEqual(detail, { enabled: false, autosave: true, highlights: true });

  const stored = window.localStorage.getItem(PREFERENCES_KEY);
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => stored,
      setItem: () => { throw new Error('unavailable'); },
    },
  });
  assert.deepEqual(updatePreferences({ autosave: false }), { enabled: false, autosave: false, highlights: true });
});

test('toolbar app renders settings, updates toggles, opens frontmatter, and follows placement', () => {
  const window = installWindow();
  const canvas = window.document.createElement('div');
  let placementHandler: ((event: { placement: 'bottom-left' }) => void) | undefined;
  toolbarApp.init(canvas as never, {
    onToolbarPlacementUpdated(handler: typeof placementHandler) { placementHandler = handler; },
  } as never);

  const toolbarWindow = canvas.querySelector<HTMLElement>('astro-dev-toolbar-window');
  assert.ok(toolbarWindow);
  assert.equal((toolbarWindow as HTMLElement & { placement: string }).placement, 'bottom-center');
  const mark = toolbarWindow.querySelector<SVGElement>('.mark svg');
  assert.equal(mark?.getAttribute('data-icon'), 'file-pen-line');
  assert.equal(mark?.getAttribute('aria-hidden'), 'true');
  assert.equal(toolbarWindow.querySelector('h1')?.textContent, 'Page editor');
  const toggles = [...canvas.querySelectorAll<HTMLElement>('astro-dev-toolbar-toggle')]
    .map((toggle) => (toggle as HTMLElement & { input: HTMLInputElement }).input);
  assert.equal(toggles.length, 3);
  toggles[1].checked = false;
  toggles[1].dispatchEvent(new window.Event('change'));
  assert.equal(readPreferences().autosave, false);

  let frontmatterOpened = false;
  window.document.addEventListener(FRONTMATTER_EVENT, () => { frontmatterOpened = true; });
  canvas.querySelector<HTMLButtonElement>('.frontmatter button')?.click();
  assert.equal(frontmatterOpened, true);

  placementHandler?.({ placement: 'bottom-left' });
  assert.equal((toolbarWindow as HTMLElement & { placement: string }).placement, 'bottom-left');
});

test('toolbar app uses the current Astro toolbar placement', () => {
  const window = installWindow();
  (window as Window & { __astro_dev_toolbar__?: { placement: string } }).__astro_dev_toolbar__ = {
    placement: 'bottom-right',
  };
  const canvas = window.document.createElement('div');
  toolbarApp.init(canvas as never, { onToolbarPlacementUpdated() {} } as never);
  const toolbarWindow = canvas.querySelector<HTMLElement>('astro-dev-toolbar-window');
  assert.equal((toolbarWindow as HTMLElement & { placement: string }).placement, 'bottom-right');
});
