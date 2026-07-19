# Astro WYSIWYG

Edit rendered Astro content in place during development. Changes are written back to `.astro`, `.md`, or `.mdx` source files, while production builds remain unchanged.

During `astro dev`, the integration maps rendered elements to their source ranges, loads an in-browser editor, and sends validated changes to a local endpoint that updates those ranges.

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

## Use

Start Astro in development mode, then click supported page text to edit it. The editor provides inline formatting, links, lists, headings, block controls, undo, and save actions.

Open **Page editor** in Astro's development toolbar to enable or disable editing, autosave, editable outlines, and Markdown frontmatter editing.

Changes save after 500 ms by default. Explicit Save and Done actions remain available when autosave is disabled.

## Options

```js
wysiwyg({
  saveDelay: 800,
  endpoint: '/_astro-wysiwyg/save',
});
```

- `saveDelay`: delay before autosaving, in milliseconds. Default: `500`.
- `endpoint`: local development endpoint for source writes. Default: `/_astro-wysiwyg/save`.

## Supported content

The editor supports static paragraphs, headings, list items, common text-bearing Astro elements, and standard inline Markdown formatting. It can also add, delete, or change supported blocks.

Dynamic Astro expressions, MDX components, and Markdown constructs that cannot be written back safely are left unchanged.

## Safety

Source writes run only under `astro dev`. The endpoint accepts same-origin requests from loopback clients and confines writes to supported source files inside the configured `src` directory.

Do not expose the development editor through a LAN host, reverse proxy, or tunnel.

## Browser support

The editor supports current desktop Chromium, Firefox, and Safari.

## Development

Run the fast tests and TypeScript build:

```sh
npm run check:unit
```

Run the full test and coverage gate:

```sh
npm run check
```
