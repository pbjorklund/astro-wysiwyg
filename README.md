# Astro WYSIWYG

Edit Astro pages in the browser and save changes directly to `.astro`, `.md`, and `.mdx` files. `WYSIWYG` means "what you see is what you get": click rendered content, change it in place, and keep working without switching to a source editor.

[![Watch Astro WYSIWYG edit rendered content and save it to Markdown](https://raw.githubusercontent.com/pbjorklund/astro-wysiwyg/main/.github/assets/astro-wysiwyg-demo.gif)](https://github.com/pbjorklund/astro-wysiwyg/blob/main/.github/assets/astro-wysiwyg-demo.mp4)

## Quick start

Add the integration to an existing Astro project:

```sh
npx astro add astro-wysiwyg
```

Start the development server:

```sh
npm run dev
```

1. Open your local Astro site.
2. Click any outlined text to start editing.
3. Change the content and formatting in place. Changes save to the source file automatically.

Open **Page editor** in Astro's development toolbar to turn editing, autosave, or editable outlines on and off, and to edit supported frontmatter fields.

## Manual setup

Install the package:

```sh
npm install --save-dev astro-wysiwyg
```

Add it to `astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';
import wysiwyg from 'astro-wysiwyg';

export default defineConfig({
  integrations: [wysiwyg()],
});
```

## Configuration

```js
wysiwyg({
  saveDelay: 800,
  endpoint: '/_astro-wysiwyg/save',
});
```

| Option | Default | Description |
| --- | --- | --- |
| `saveDelay` | `500` | Delay before autosaving, in milliseconds. |
| `endpoint` | `/_astro-wysiwyg/save` | Local development endpoint used to save edits. |

## Supported content

Astro WYSIWYG supports static paragraphs, headings, lists, common text elements, inline Markdown formatting, links, and supported frontmatter values. You can also add, delete, or change supported blocks.

Expressions, components, and Markdown constructs that cannot be mapped safely to one source value remain read-only.

## Requirements

- Astro 5 or 6
- Node.js 18.17.1 or newer
- A current desktop version of Chromium, Firefox, or Safari

## Safety

The editor runs under `astro dev` and is not added to production builds. Source writes are limited to supported files inside `src` and requests from the local site.

Keep the development server local. Do not expose the editor through a public tunnel, LAN host, or reverse proxy.

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/pbjorklund/astro-wysiwyg/issues).

---

Supported by [AmpliFlow](https://www.ampliflow.com/).
