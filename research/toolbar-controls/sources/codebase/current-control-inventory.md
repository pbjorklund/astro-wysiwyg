# Current control inventory

Fetched from the repository on 2026-07-20.

## Contextual toolbar

Source: `src/client.ts:1357-1432`

| Group | Visible control | Accessible name | Shortcut or state | Current presentation |
|---|---|---|---|---|
| History | `↶` | Undo | `Ctrl/Cmd+Z`; disabled with no undo target | Unicode glyph, icon-only |
| Inline formatting | `B` | Bold | `Ctrl/Cmd+B` | Styled letter |
| Inline formatting | `I` | Italic | `Ctrl/Cmd+I` | Styled letter |
| Inline formatting | Link | Link | `Ctrl/Cmd+K` | Text label |
| Lists | `• List` | Bullet list | `Ctrl/Cmd+Shift+8` | Symbol plus text |
| Lists | `1. List` | Numbered list | `Ctrl/Cmd+Shift+7` | Symbol plus text |
| Structure | `+ Block` | Add block below | Disabled for frontmatter markers | Symbol plus text |
| Structure | Delete | Delete block | Disabled for frontmatter markers; confirm before delete | Text label plus danger color/border |
| Link editor | Apply | Apply link | Visible only while link editor is open | Text label |
| Link editor | Remove | Remove link | Disabled when selection is not an existing link | Text label |
| Link editor | Cancel | Cancel link | Visible only while link editor is open | Text label |
| Block type | H1 through H6 | Heading 1 through Heading 6 | `Alt+1` through `Alt+6` | Seven adjacent abbreviation buttons with Paragraph |
| Block type | P | Paragraph | No shortcut | Abbreviation |
| Session | Save | Save | `Ctrl/Cmd+S`; remains useful when autosave is off | Text label |
| Session | Done | Done | `Escape`; saves before exit when needed | Text label |
| Status | Editing, Unsaved, Saving, Saved, or error text | Status | Polite live region; errors wrap | Persistent text |

The toolbar is one flex row with 3px gaps, 6px padding, 36px minimum button targets, and horizontal overflow at `max-width: calc(100vw - 16px)` (`src/client.ts:1360-1367`). Separators split history, formatting/list, structure, block type, and session controls (`src/client.ts:1393-1422`). The link editor is inserted in that row and can add a URL field plus three text buttons and an error message (`src/client.ts:1404-1410`).

## Keyboard and focus behavior

- Document shortcuts cover numbered list, bullet list, link, undo, bold, italic, save, toolbar entry, headings, and exit (`src/client.ts:486-518`).
- `Alt+F10` focuses the first non-disabled toolbar button. There is no roving `tabindex`, Left/Right navigation, Home/End navigation, or remembered toolbar item (`src/client.ts:509-510`, `src/client.ts:520-535`).
- `Escape` closes frontmatter first, then link editing, then the editing session (`src/client.ts:529-534`).
- Pointer-down on a toolbar button prevents the active content selection from collapsing before the click action runs (`src/client.ts:136-138`).
- Toolbar controls use native buttons and inputs. Focus-visible gets a 3px outline (`src/client.ts:1371`).
- Toolbar positioning clamps the toolbar inside an 8px viewport inset, but it measures the entire horizontally scrollable toolbar rather than a wrapped group layout (`src/client.ts:1265-1274`).

## Related development-toolbar controls

Source: `src/toolbar-app.ts:8-89`

| Surface | Control | Presentation |
|---|---|---|
| Page editor window | Enable editing | Labeled toggle with description |
| Page editor window | Autosave changes | Labeled toggle with description |
| Page editor window | Show editable outlines | Labeled toggle with description |
| Page editor window | Edit frontmatter | Visible text button |
| Page editor identity | E | Decorative letter mark next to `Page editor` |

The frontmatter dialog opened from that window has field labels, Save frontmatter, Cancel, and an alert message (`src/client.ts:1424-1432`). These form actions should stay text-labeled because they are infrequent, high-context actions inside a dialog rather than dense formatting commands.

## Planned media actions

Tasks #14 and #15 add image and video flows. The compact toolbar only needs entry points. File selection, destination name, alt text or text alternative, poster and playback settings, upload progress, validation, Insert, and Cancel belong in a dialog or panel with visible labels.

| Planned capability | Compact toolbar trigger | Form or follow-up controls |
|---|---|---|
| Insert image | Image item in an Insert menu | Choose file, destination, alt text, Upload/Insert, Cancel; later edit/replace/remove path |
| Insert video | Video item in an Insert menu | Choose file, destination, accessible label or nearby alternative, poster, controls, preload, muted, loop, autoplay constraints, Upload/Insert, Cancel; later edit/replace/remove path |
| Insert paragraph below | Paragraph item in the same Insert menu | Replaces the current `+ Block` trigger without changing its operation |

## Implementation limits

- The package has no production dependencies. An icon choice should not force a runtime package into consumers unless bundle evidence justifies it (`package.json`).
- Existing `data-action`, `data-command`, `data-list`, and `data-tag` hooks drive behavior and tests. A redesign can change presentation while keeping those hooks, except where the approved Text style and Insert menus intentionally replace the seven block-type buttons and Add block trigger.
- Inline formatting state is not exposed with `aria-pressed`. A stateful visual design needs command-state detection rather than CSS alone.
- The current link group contains a textbox inside the toolbar. ARIA toolbar guidance reserves arrow keys for toolbar navigation and cautions about controls that also need those keys, so the link editor is safer as a popover or dialog with its own focus scope.
- A wrapped or overflow layout changes toolbar height. `positionToolbar()` already measures current height, but tests must cover relayout after menus, validation messages, and viewport changes.

> Editorial analysis is in `../../overview.md`.
