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

Open **Page editor** in Astro's development toolbar to turn editing, autosave, or editable outlines on and off, and to edit supported frontmatter fields. The in-page toolbar groups formatting by task, keeps common actions in reach, and uses named **Text style** and **Insert** menus. Use **Insert > Image** to upload a raster image, or **Insert > Video** to upload an H.264 MP4 and insert a native player with controls, an accessible label, and a visible description. Select a supported image and use **Replace image** to upload a replacement or choose an existing project asset, preview it, and update its alt text without losing compatible attributes, links, or captions. The toolbar wraps at narrow widths and supports arrow-key navigation from `Alt+F10`. Saving keeps the active block, selection, scroll position, and toolbar in place, while external source changes still reload normally.

## Explore and develop

The maintained [`demo/`](demo/) site shows Astro, Markdown, MDX, formatting, links, lists, images, native video, block structure, frontmatter, navigation, interactive-content guards, and recovery behavior.

To run it against the current package source:

```sh
npm ci
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the demo routes, isolated Playwright workflow, production check, and feature-fixture conventions.

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
  imageDirectory: 'assets',
  videoDirectory: 'assets',
});
```

| Option | Default | Description |
| --- | --- | --- |
| `saveDelay` | `500` | Delay before autosaving, in milliseconds. |
| `endpoint` | `/_astro-wysiwyg/save` | Local development endpoint used to save edits and upload media. |
| `imageDirectory` | `assets` | Relative directory under Astro's configured `publicDir` for uploaded images. |
| `videoDirectory` | `assets` | Relative directory under Astro's configured `publicDir` for uploaded videos. |

## Supported content

Astro WYSIWYG supports static paragraphs, headings, lists, common text elements, inline Markdown formatting, links, raster image uploads, and supported frontmatter values. You can also add, delete, or change supported blocks. Uploaded images are limited to 5 MB, saved under `public/assets` by default, and inserted as native Astro or Markdown syntax with required alt text. Select an inserted image block and use **Delete** to remove its source reference; the uploaded asset remains available for reuse.

Image replacement supports one recognized image in a source-backed block:

- Markdown and MDX image syntax can use an existing public URL path or a relative image under `src`.
- Astro `<img>` elements with a static public `src` can use another public asset.
- Astro `<img>` elements using a dedicated default import such as `src={photo.src}` can switch to another relative source asset while keeping the import name. Shared imports remain read-only.

Replacement keeps compatible image attributes and surrounding source, including links, titles, captions, and nearby text. It changes only the image reference and alt text. Remote URLs, SVG files, generated expressions, ambiguous blocks with several images, and framework image components remain read-only.

Video insertion accepts H.264 video in an MP4 container up to 100 MB. Astro, Markdown, and MDX receive portable native `<figure>` and `<video>` markup with a typed `<source>`, native controls, an accessible label, a visible `<figcaption>`, a download fallback, and optional public poster image. Authors can choose preload, muted, loop, and autoplay settings. Autoplay requires muted playback. Spoken prerecorded content still needs captions added in source.

Other expressions, components, media formats, and Markdown constructs that cannot be mapped safely to one source value remain read-only.

## Requirements

- Astro 5 or 6
- Node.js 18.17.1 or newer
- A current desktop version of Chromium, Firefox, or Safari

## Safety

The editor runs under `astro dev` and is not added to production builds. Source writes are limited to supported files inside `src`. Image and video writes are limited to their configured directories under Astro's `publicDir`; file names, declared types, container signatures, codecs, sizes, collisions, and symlink boundaries are checked before a new asset appears. Existing public and source image assets are confined to their project roots and checked before preview or replacement. Requests must come from the local site.

Keep the development server local. Do not expose the editor through a public tunnel, LAN host, or reverse proxy.

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/pbjorklund/astro-wysiwyg/issues).

---

Supported by [AmpliFlow](https://www.ampliflow.com/).
