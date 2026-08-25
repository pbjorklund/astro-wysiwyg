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

Open **Page editor** in Astro's development toolbar to turn editing, autosave, or editable outlines on and off, edit supported frontmatter fields, or create an entry in a writable local content collection. The in-page toolbar groups formatting by task, keeps common actions in reach, and uses named **Text style**, **Insert**, and **Replace block** menus. The content picker can add a paragraph, heading, bulleted or numbered list, blockquote, code block, divider, image, video, or iframe. Select a supported static block to replace its type without re-entering text. The editor confirms changes that remove formatting, list structure, quoted or code semantics, or content, and **Undo** restores the prior source-backed block. Media replacement preserves compatible source markup, while iframe editing requires a validated preview before saving. The toolbar wraps at narrow widths and supports arrow-key navigation from `Alt+F10`. Saving keeps the active block, selection, scroll position, and toolbar in place, while external source changes still reload normally.

## Explore and develop

The maintained [`demo/`](demo/) site shows Astro, Markdown, MDX, formatting, links, context-aware static content types, local content collection creation, images, native video, safe iframes, frontmatter, navigation, interactive-content guards, and recovery behavior.

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
  iframeOrigins: ['self', 'https://www.youtube-nocookie.com'],
});
```

| Option | Default | Description |
| --- | --- | --- |
| `saveDelay` | `500` | Delay before autosaving, in milliseconds. |
| `endpoint` | `/_astro-wysiwyg/save` | Local development endpoint used to save edits and upload media. |
| `imageDirectory` | `assets` | Relative directory under Astro's configured `publicDir` for uploaded images. |
| `videoDirectory` | `assets` | Relative directory under Astro's configured `publicDir` for uploaded videos. |
| `iframeOrigins` | `['self']` | Approved iframe sources. Use `self` for root-relative local paths and exact HTTPS origins for external providers. Wildcards are rejected. |

## Supported content

Astro WYSIWYG supports static paragraphs, headings, bulleted and numbered lists, blockquotes, fenced code blocks, dividers, common inline formatting, links, raster image uploads, and supported frontmatter values. The same explicit content registry drives context filtering, default values, source serialization, replacement compatibility, toolbar metadata, and the image, video, and iframe dialog registrations.

Use **Insert** after any source-backed block to add a valid type for that Astro, Markdown, or MDX context. Use **Replace block** on a recognized static block to keep its text while changing its type. Paragraphs and headings convert directly. Changes that flatten inline formatting, list structure, blockquotes, code blocks, multiline headings, or all content require confirmation. **Undo** removes a new insertion or restores the prior type, heading level, structure, and safe inline formatting through another conflict-checked source write. Dynamic expressions, components, ambiguous nested structures, and unsupported source forms remain read-only.

Use **Page editor > Create entry** to create a Markdown or MDX file in a recognized local `glob()` content collection. The editor reads literal `base` and `pattern` settings plus a static `z.object()` schema from `src/content.config.*`. It supports required and optional string, number, boolean, coerced date, and string-array fields. Required unsupported field types, dynamic schemas, custom loaders, remote loaders, and collection roots outside `src/content` are listed with the reason they cannot be created.

The create form requires a lowercase hyphenated slug, validates every supported schema field, and adds a bounded starter body. It follows the collection's existing flat-file or `slug/index` style and preferred `.md` or `.mdx` extension. Creation never replaces an existing Markdown or MDX entry. After creation, the dialog links to a route only when a non-prerendered collection route can accept the new slug immediately. Static `getStaticPaths()` routes receive the exact file, restart step, and suggested URL instead.

Uploaded images are limited to 5 MB, saved under `public/assets` by default, and inserted as native Astro or Markdown syntax with required alt text. Select an inserted image block and use **Delete** to remove its source reference; the uploaded asset remains available for reuse.

Image replacement supports one recognized image in a source-backed block:

- Markdown and MDX image syntax can use an existing public URL path or a relative image under `src`.
- Astro `<img>` elements with a static public `src` can use another public asset.
- Astro `<img>` elements using a dedicated default import such as `src={photo.src}` can switch to another relative source asset while keeping the import name. Shared imports remain read-only.

Replacement keeps compatible image attributes and surrounding source, including links, titles, captions, and nearby text. It changes only the image reference and alt text. Remote URLs, SVG files, generated expressions, ambiguous blocks with several images, and framework image components remain read-only.

Video insertion accepts H.264 video in an MP4 container up to 100 MB. Astro, Markdown, and MDX receive portable native `<figure>` and `<video>` markup with a typed `<source>`, native controls, an accessible label, a visible `<figcaption>`, a download fallback, and optional public poster image. Authors can choose preload, muted, loop, and autoplay settings. Autoplay requires muted playback. Spoken prerecorded content still needs captions added in source.

Video replacement supports a source-backed native `<figure>` containing one static public MP4 `<source>`, explicit controls, preload and accessible label, and one plain-text `<figcaption>`. Authors can upload a new H.264 MP4 or choose a validated MP4 already under Astro's public directory. Replacement can update the public poster, label, description, preload, muted, loop, and autoplay settings. Compatible figure and video attributes, caption tracks, fallback markup, and nearby source remain in place; matching fallback download links follow the new video URL. Existing video and poster files are never deleted automatically.

Iframe insertion and editing support one static native `<iframe>` in Astro, Markdown, or MDX. Authors must preview the iframe before saving and provide a same-origin root-relative path or a URL from an exact HTTPS origin in `iframeOrigins`. The editor requires an accessible title and bounded integer dimensions, and exposes fixed loading, referrer-policy, permission-policy, sandbox, and fullscreen choices. Saved source contains only the native iframe, with no editor component or runtime wrapper. Existing static iframes remain editable through an editor-only **Edit iframe** button over the live frame.

Relative iframe paths reject traversal, query strings, and fragments. External URLs reject credentials, non-HTTPS schemes, protocol-relative forms, and unapproved origins. Same-origin iframes cannot combine `allow-scripts` with `allow-same-origin`. Dynamic iframe expressions, unknown attributes or policy tokens, iframe fallback children, wildcard providers, dynamic media expressions, remote media, several video sources in one player, nested caption markup, custom players, unsupported media formats, and other constructs that cannot be mapped safely to one source value remain read-only.

## Requirements

- Astro 5, 6, or 7
- Node.js 18.17.1 or newer
- A current desktop version of Chromium, Firefox, or Safari

## Safety

The editor runs under `astro dev` and is not added to production builds. Source writes are limited to supported files inside `src`. Content collection creation is limited to statically recognized local glob roots under `src/content`; slugs, schemas, fields, extensions, naming conventions, collisions, symlinks, and route guidance are checked before a file appears. Image and video writes are limited to their configured directories under Astro's `publicDir`; file names, declared types, container signatures, codecs, sizes, collisions, and symlink boundaries are checked before a new asset appears. Existing image and video assets are confined to their approved project roots and checked before preview or replacement. Iframes are limited to same-origin paths or configured exact HTTPS origins, and their full attribute policy is revalidated before preview and before each source write. Requests must come from the local site.

Keep the development server local. Do not expose the editor through a public tunnel, LAN host, or reverse proxy.

## Support

Found a bug or have a feature request? [Open an issue](https://github.com/pbjorklund/astro-wysiwyg/issues).

---

Supported by [AmpliFlow](https://www.ampliflow.com/).
