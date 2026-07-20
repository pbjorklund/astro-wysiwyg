import { defineToolbarApp } from 'astro/toolbar';
import { lucideIcon } from './lucide-icons.ts';
import {
  FRONTMATTER_EVENT,
  type EditorPreferences,
  readPreferences,
  updatePreferences,
} from './preferences.ts';

const rows: Array<{
  key: keyof EditorPreferences;
  name: string;
  description: string;
}> = [
  {
    key: 'enabled',
    name: 'Enable editing',
    description: 'Click source-backed text to edit it on the page.',
  },
  {
    key: 'autosave',
    name: 'Autosave changes',
    description: 'Save after you stop typing. Save and Done still work when disabled.',
  },
  {
    key: 'highlights',
    name: 'Show editable outlines',
    description: 'Outline source-backed text before you start editing it.',
  },
];

export default defineToolbarApp({
  init(canvas, app) {
    const windowElement = document.createElement('astro-dev-toolbar-window');
    const toolbarMetadata = window as Window & {
      __astro_dev_toolbar__?: { placement?: 'bottom-left' | 'bottom-center' | 'bottom-right' };
    };
    windowElement.placement = toolbarMetadata.__astro_dev_toolbar__?.placement ?? 'bottom-center';
    windowElement.innerHTML = `
      <style>
        :host { color-scheme: dark; }
        header { display: flex; align-items: center; gap: 10px; }
        h1 { margin: 0; color: #fff; font: 600 22px/1.2 system-ui, sans-serif; }
        .mark { display: grid; place-items: center; width: 36px; height: 36px; color: #13151a; background: #c4b5fd; border-radius: 8px; }
        .mark svg { width: 22px; height: 22px; }
        .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 0; }
        .setting-row + .setting-row { border-top: 1px solid #343841; }
        h2 { margin: 0 0 5px; color: #fff; font: 400 16px/1.3 system-ui, sans-serif; }
        p { margin: 0; max-width: 430px; color: #b9bec7; font: 14px/1.5 system-ui, sans-serif; }
        .frontmatter { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 0; border-top: 1px solid #343841; }
        button { min-height: 36px; padding: 7px 12px; color: #fff; background: #6d28d9; border: 1px solid #8b5cf6; border-radius: 6px; font: 600 14px/1.2 system-ui, sans-serif; cursor: pointer; }
        button:hover { background: #7c3aed; }
        button:focus-visible { outline: 3px solid #c4b5fd; outline-offset: 2px; }
        footer { margin-top: 8px; padding-top: 14px; border-top: 1px solid #343841; color: #8d929c; font: 13px/1.4 system-ui, sans-serif; }
      </style>
      <header><span class="mark" aria-hidden="true">${lucideIcon('file-pen-line')}</span><h1>Page editor</h1></header>
      <hr />
      <section class="settings" aria-label="Page editor settings"></section>
      <section class="frontmatter" aria-labelledby="frontmatter-title">
        <span><h2 id="frontmatter-title">Article metadata</h2><p>Edit the current Markdown or MDX page's frontmatter.</p></span>
        <button type="button">Edit frontmatter</button>
      </section>
      <footer>Settings are stored in this browser for the current local site.</footer>
    `;

    const container = windowElement.querySelector<HTMLElement>('.settings')!;
    const preferences = readPreferences();
    for (const row of rows) {
      const label = document.createElement('label');
      label.className = 'setting-row';
      const copy = document.createElement('span');
      copy.innerHTML = `<h2>${row.name}</h2><p>${row.description}</p>`;
      const toggle = document.createElement('astro-dev-toolbar-toggle');
      toggle.toggleStyle = 'purple';
      toggle.input.checked = preferences[row.key];
      toggle.input.setAttribute('aria-label', row.name);
      toggle.input.addEventListener('change', () => {
        updatePreferences({ [row.key]: toggle.input.checked });
      });
      label.append(copy, toggle);
      container.append(label);
    }

    windowElement.querySelector<HTMLButtonElement>('.frontmatter button')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent(FRONTMATTER_EVENT));
    });

    canvas.replaceChildren(windowElement);
    app.onToolbarPlacementUpdated(({ placement }) => {
      windowElement.placement = placement;
    });
  },
});
