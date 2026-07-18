# Astro WYSIWYG

Edit rendered Astro content in place during development. The page keeps its normal CSS, while text and inline formatting are written back to the `.astro`, `.md`, or `.mdx` source file.

The integration adds no editor markup or client code to production builds.

## Install

```sh
npm install --save-dev astro-wysiwyg
```

Add the integration to `astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';
import wysiwyg from 'astro-wysiwyg';

export default defineConfig({
  integrations: [wysiwyg()],
});
```

For a local checkout, use its path instead:

```sh
npm install --save-dev ../astro-wysiswyg
```

Start Astro with `npm run dev`, then click an editable text block.

## Controls

| Action | Control |
| --- | --- |
| Undo the last block checkpoint | `Ctrl+Z`, `Cmd+Z`, or **Undo** |
| Bold | `Ctrl+B` or `Cmd+B` |
| Italic | `Ctrl+I` or `Cmd+I` |
| Add or edit a link | `Ctrl+K`, `Cmd+K`, or **Link** |
| Numbered list | `Ctrl+Shift+7`, `Cmd+Shift+7`, or **Numbered list** |
| Bullet list | `Ctrl+Shift+8`, `Cmd+Shift+8`, or **Bullet list** |
| Heading 1-6 | `Alt+1` through `Alt+6` |
| Move focus to the toolbar | `Alt+F10` |
| Save now | `Ctrl+S`, `Cmd+S`, or **Save** |
| Finish editing | `Escape` or **Done** |

The floating toolbar also has Undo, Bold, Italic, Link, Bullet list, Numbered list, Frontmatter, H1-H6, Paragraph, Save, and Done buttons. Select text before adding a link, or place the caret inside an existing link to edit or remove it. List controls convert the current block and can switch an existing list between bullet and numbered forms. **Frontmatter** opens a form for the current content file's simple one-line fields, including strings, dates, numbers, lists, and booleans. Changes save after 500 ms by default. If Astro reloads a content-collection page after the write, the same block and caret return to edit mode automatically.

## Dev toolbar controls

Open **Page editor** (the pencil icon) in Astro's dev toolbar to control the editor:

- **Enable editing** turns all click-to-edit behavior on or off.
- **Autosave changes** saves after typing stops. Save, Done, and `Ctrl+S` still work when it is off.
- **Show editable outlines** controls the hover and keyboard-focus hints.

These settings are stored in the browser for the current local site.

## Options

```js
wysiwyg({
  saveDelay: 800,
  endpoint: '/_astro-wysiwyg/save',
})
```

- `saveDelay`: milliseconds to wait after input before saving. Default: `500`.
- `endpoint`: local dev-server path used for source writes. Default: `/_astro-wysiwyg/save`.

## Editable source

The integration edits source blocks it can map without guessing:

- Static paragraphs, headings, list items, and common text-bearing elements in `.astro` files.
- Paragraphs, headings, and list items in Markdown and MDX.
- Inline bold, italic, links, code, and other standard formatting inside those blocks.

Astro attributes and classes stay on the original element. Markdown formatting is converted back from the browser DOM to Markdown syntax. Rendered `data.title`, `data.description`, and `frontmatter.title` text maps back to Markdown frontmatter. Article cards use their `/collection/slug` link to find the matching `src/content/collection/slug` source file.

Other dynamic Astro expressions are not editable. MDX blocks containing components are also skipped. Their rendered text may come from code, a CMS, or another file, so changing the visible HTML would not identify one safe source location.

## Development safety

Source writes run only under `astro dev`. The endpoint accepts same-origin JSON requests, confines file paths to the Astro project root, allows only Astro and Markdown source extensions, and rejects stale or ambiguous source ranges.

Run the checks with:

```sh
npm run check
npm run test:e2e
```
