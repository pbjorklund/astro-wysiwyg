# Icon library source excerpts

Fetched and checked 2026-07-20.

## Lucide guide

- Organization: Lucide contributors
- Date: live documentation
- URL: https://lucide.dev/guide/
- Status: HTTP 200, retrieved directly

> Lucide is an open-source icon library that provides 1600+ vector (svg) files for displaying icons and symbols in digital and non-digital projects.

> These rules maintain standards for the icons, such as recognizability, consistency in style, and readability at all sizes.

> Lucide uses SVG compression and specific code architecture for tree-shaking abilities. After tree-shaking, you only ship the icons you used.

## Lucide accessibility guide

- Organization: Lucide contributors
- Date: live documentation
- URL: https://lucide.dev/guide/accessibility
- Status: HTTP 200, retrieved directly

> Icons are a helpful tool to improve perception, but they aren't a replacement for text.

> In most cases, it is probably a good idea to also provide a textual representation of your icon's function.

> Small targets can be difficult to click or touch, if your icon is interactive, we recommend that it should have a minimum target size of 44x44 pixels.

> Maintain consistency in icon design and usage across your interface to help users learn and understand their meanings more easily.

> As previously stated, you should provide your accessible label on the icon button itself, not the contained icon.

## Lucide static assets

- Organization: Lucide contributors
- Date: live documentation
- URL: https://lucide.dev/guide/static/
- Status: HTTP 200, retrieved directly

> Static assets and utilities for Lucide icons that work without JavaScript frameworks.

> Use individual SVG files as images or CSS background images.

> Build static websites and applications without JavaScript framework dependencies.

## Lucide license and package inventory

- Organization: Lucide contributors
- Date: repository license copyright 2026
- URL: https://github.com/lucide-icons/lucide/blob/main/LICENSE
- Raw URL: https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE
- Status: HTTP 200, retrieved directly

The project uses the ISC License. The license permits use, copy, modification, and distribution when the copyright notice and permission notice remain in copies.

Registry check: `lucide-static@1.25.0`, ISC license, 5,522 package files. The package was unpacked in a temporary directory to verify exact SVG coverage. It contains `undo-2`, `bold`, `italic`, `link`, `list`, `list-ordered`, `heading-1` through `heading-6`, `pilcrow`, `type`, `plus`, `trash-2`, `save`, `check`, `image-plus`, `video`, and `x`.

## Heroicons

- Organization: Tailwind Labs
- Date: live site and repository license
- URLs: https://heroicons.com/ and https://github.com/tailwindlabs/heroicons/blob/master/LICENSE
- Status: HTTP 200, retrieved directly

The first-party site lists 316 icons and 24x24 outline icons with a 1.5px stroke. The repository uses the MIT License.

## Tabler Icons

- Organization: Tabler contributors
- Date: live site and repository license copyright 2020-2026
- URLs: https://tabler.io/icons and https://github.com/tabler/tabler-icons/blob/main/LICENSE
- Status: HTTP 200, retrieved directly

> A complete icon set with 6166 icons featuring perfect line weights and spacing.

> You can use the icons as HTML images, embed them in your HTML code, create an SVG sprite or render them in React.

> Every icon is designed on a 24x24 grid and a 2px stroke.

The site and repository identify the source as MIT licensed.

## Registry comparison

| Library | Checked release | License | Unpacked size | File count | Relevant limit |
|---|---:|---|---:|---:|---|
| `lucide-static` | 1.25.0 | ISC | 47,396,053 bytes | 5,522 | Static package contains individual SVG files |
| `heroicons` | 2.2.0 | MIT | 700,262 bytes | 1,291 | First-party site lists 316 named icons |
| `@tabler/icons` | 3.45.0 | MIT | 11,196,505 bytes | 11,316 | First-party site lists 6,166 icons |

## Fetch failures

- Lucide icon search query returned no indexed results. Package extraction provided direct file-level coverage instead.
- No license fetch failed. All three repository license URLs returned HTTP 200.

> Editorial analysis is in `../../overview.md`.
