# Sources: Toolbar controls

Research fetched 2026-07-20. Source excerpts and local evidence are under `sources/`. Editorial analysis is in `overview.md`.

## Source files

| File | Coverage | Source count |
|---|---|---:|
| `sources/codebase/current-control-inventory.md` | Current controls, keyboard behavior, responsive CSS, tests, and planned media actions | Repository plus tasks #12, #14, and #15 |
| `sources/editors/editor-toolbar-sources.md` | CKEditor, TinyMCE, WordPress block editor, and Tiptap toolbar patterns | 7 URLs |
| `sources/accessibility/accessibility-sources.md` | WAI-ARIA toolbar behavior, WCAG 2.2, Carbon, and GitLab guidance | 9 used URLs, 1 excluded partial URL |
| `sources/accessibility/icon-library-sources.md` | Lucide, Heroicons, and Tabler documentation, licenses, packages, and verified icon coverage | 8 URLs plus npm registry metadata |

## Primary sources

| Source | Organization | URL | Stance |
|---|---|---|---|
| Editor toolbars | CKSource | https://ckeditor.com/docs/ckeditor5/latest/getting-started/setup/toolbar.html | Supports groups, dropdowns, wrapping, and automatic overflow |
| Accessibility support | CKSource | https://ckeditor.com/docs/ckeditor5/latest/features/accessibility.html | Supports `Alt+F10`, arrow navigation, execution keys, and `Esc` |
| Toolbar configuration | Tiny Technologies | https://www.tiny.cloud/docs/tinymce/latest/toolbar-configuration-options/ | Supports complete groups, drawers, scrolling, and wrapping |
| Accessible navigation guide | Tiny Technologies | https://www.tiny.cloud/docs/tinymce/latest/tinymce-and-screenreaders/ | Supports toolbar entry, arrow navigation, group navigation, and exit |
| Work with blocks | WordPress.org | https://wordpress.org/documentation/article/work-with-blocks/ | Supports contextual essentials, icon labels, and More actions |
| Image block | WordPress.org | https://wordpress.org/documentation/article/image-block/ | Supports an insertion flow followed by detailed media controls |
| Custom menu | Tiptap | https://tiptap.dev/docs/editor/getting-started/style-editor/custom-menus | Supports keyboard navigation, ARIA, shortcuts, and icon use |
| Toolbar pattern | W3C WAI | https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/ | Supports grouped controls, one Tab stop, and arrow navigation |
| Toolbar example | W3C WAI | https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/examples/toolbar/ | Supports remembered focus and accessible popup labels |
| Target Size (Minimum) | W3C WAI | https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum | Sets the 24 by 24 CSS pixel AA threshold and exceptions |
| Reflow | W3C WAI | https://www.w3.org/WAI/WCAG22/Understanding/reflow.html | Supports reducing two-dimensional scrolling at narrow widths |
| Content on Hover or Focus | W3C WAI | https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html | Constrains custom tooltip behavior |
| Tooltip accessibility | IBM Carbon | https://carbondesignsystem.com/components/tooltip/accessibility/ | Supports action tooltips for icon-only buttons, with familiar-icon exceptions |
| Icon usage | IBM Carbon | https://carbondesignsystem.com/elements/icons/usage/ | Recommends 44px interactive icon targets |
| Button | GitLab Pajamas | https://design.gitlab.com/components/button | Requires icon-button accessible names and tooltips |
| Iconography | GitLab Pajamas | https://design.gitlab.com/product-foundations/iconography | Supports consistent semantics and context for ambiguous icons |
| Lucide guide | Lucide contributors | https://lucide.dev/guide/ | Documents consistent SVG design and selective shipping |
| Lucide accessibility | Lucide contributors | https://lucide.dev/guide/accessibility | Supports visible labels, button-level names, and 44px targets |
| Lucide static assets | Lucide contributors | https://lucide.dev/guide/static/ | Supports selected SVGs without a framework dependency |
| Lucide license | Lucide contributors | https://github.com/lucide-icons/lucide/blob/main/LICENSE | ISC license terms |
| Heroicons | Tailwind Labs | https://heroicons.com/ | MIT alternative with a smaller general-interface catalog |
| Tabler Icons | Tabler contributors | https://tabler.io/icons | MIT alternative with a broad 24px SVG catalog |

## Fetch notes

| Source | Result | Note |
|---|---|---|
| 22 used web pages | Retrieved | HTTP 200 with topic-matching text, or direct raw license text |
| Material Design 3 icon-button accessibility | Partial, excluded | The application shell and all fallback fetches did not expose reliable article text for quotation |
| Lucide icon search | No indexed result | `lucide-static@1.25.0` was unpacked in `/tmp` to verify exact SVG file names instead |

No archived or paywalled source was used.
