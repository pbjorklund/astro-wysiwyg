# Toolbar controls research

Research completed 2026-07-20 for task #11, "Research clearer toolbar icons and control patterns".

## Decision

Approve a focused redesign: use selected Lucide SVGs, keep visible labels for ambiguous or consequential actions, collapse block types and insertion into named menus, wrap complete control groups instead of scrolling the toolbar, and adopt the ARIA toolbar keyboard pattern.

### Options considered

1. **Keep the current toolbar.** This avoids implementation risk, but leaves seven adjacent block-type buttons, mixed glyph and text styles, and horizontal scrolling.
2. **Replace every label with an icon.** This creates the shortest row, but the accessibility and design-system sources warn that icons do not replace text and ambiguous meanings need context.
3. **Use selective labels, grouped controls, and named menus.** This cuts width while preserving recognition and access. This is the recommended option.
4. **Move most actions into one More menu.** This makes the row compact, but weakens discovery and adds steps for common formatting.

Option 3 wins because CKEditor, TinyMCE, and WordPress all use semantic groups or menus; W3C, Carbon, GitLab, and Lucide require names or context for icon controls; and the current action set has two natural reductions: seven block-type buttons become one Text style menu, and current plus future insertion actions become one Insert menu.

**Falsifier:** revise this direction if a 320 CSS pixel Playwright test cannot expose every action without horizontal scrolling, if screen-reader tests cannot distinguish state and action names, or if the selected Lucide SVGs add a runtime dependency or material bundle cost.

## Core findings

| Recommendation | Supporting sources | Limiting evidence |
|---|---|---|
| Group related controls and use named menus for coherent sets | CKEditor toolbar groups and nested toolbars; TinyMCE complete sequential groups; WordPress contextual essentials and More menu | Menus hide actions. Keep frequent formatting visible and use menus only for Text style and Insert. |
| Use icons selectively, not as a full replacement for text | Lucide accessibility; GitLab iconography and buttons; Carbon tooltip guidance; WordPress labels on hover/focus | Carbon exempts familiar Bold and Italic icons from mandatory tooltips. Icon-only controls are acceptable when their names remain available. |
| Wrap groups instead of requiring horizontal scanning | CKEditor wrapping; TinyMCE wrap mode; WCAG Reflow guidance | WCAG names persistent toolbars as a possible two-dimensional-layout exception. It still advises reducing unnecessary scrolling. |
| Implement one toolbar Tab stop with arrow navigation | WAI-ARIA toolbar pattern and example; CKEditor accessibility; TinyMCE navigation; Tiptap accessibility | Roving focus costs more than native Tab order. Tests must prove entry, exit, wrapping, disabled-state, menu, and focus-return behavior. |
| Use at least 44 by 44 CSS pixel button targets where the compact toolbar allows | Lucide recommends 44x44; Carbon requires 44px for interactive icons; WCAG 2.5.8 sets a 24x24 AA floor | The current 36px targets already exceed WCAG AA. Larger targets increase wrapping, so the layout must account for the extra height. |
| Use selected Lucide SVGs without a runtime icon dependency | Lucide has a consistent editor-specific family, static individual SVGs, an accessibility guide, and an ISC license | Heroicons is much smaller. Tabler is broader and MIT licensed. Either could work, but neither provided a stronger fit across this exact action map. |

## Approved control map

### Page editor identity

| Current | Approved presentation | Accessible behavior |
|---|---|---|
| Decorative `E` mark | Lucide `file-pen-line` beside visible `Page editor` | SVG is decorative (`aria-hidden="true"`, not focusable); the visible title names the app |

### Contextual toolbar

Order groups by task flow: choose structure, format content, insert or remove structure, then save or finish. Keep status separate from the button groups.

| Group | Action | Lucide icon | Label policy | State and shortcut policy |
|---|---|---|---|---|
| History | Undo | `undo-2` | Icon-only | Name `Undo`; tooltip `Undo (Ctrl/Cmd+Z)`; disabled state visible and announced |
| Block type | Text style | `type` | Icon plus current visible label, such as `Paragraph` | Menu items `Paragraph`, `Heading 1` through `Heading 6`; show `Alt+1` through `Alt+6` on heading items; button exposes expanded state |
| Format | Bold | `bold` | Icon-only | Toggle exposes `aria-pressed`; tooltip includes `Ctrl/Cmd+B` |
| Format | Italic | `italic` | Icon-only | Toggle exposes `aria-pressed`; tooltip includes `Ctrl/Cmd+I` |
| Format | Link | `link` | Icon-only | Button exposes popover state; tooltip includes `Ctrl/Cmd+K` |
| Format | Bullet list | `list` | Icon-only | Toggle exposes current list state; tooltip includes `Ctrl/Cmd+Shift+8` |
| Format | Numbered list | `list-ordered` | Icon-only | Toggle exposes current list state; tooltip includes `Ctrl/Cmd+Shift+7` |
| Structure | Insert | `plus` | Icon plus visible `Insert` | Menu exposes `Paragraph below`, `Image`, and `Video` with visible labels and `pilcrow`, `image-plus`, and `video` icons |
| Structure | Delete block | `trash-2` | Icon plus visible `Delete` | Keep danger border and text, add a shape/icon cue, preserve confirmation, and do not rely on red alone |
| Session | Save | `save` | Icon plus visible `Save` | Tooltip includes `Ctrl/Cmd+S`; saving and disabled state stay perceivable |
| Session | Done | `check` | Icon plus visible `Done` | Tooltip includes `Esc`; saves before exit as it does now |
| Status | Editing, Unsaved, Saving, Saved, or error | None | Visible text | Keep the polite live region; preserve readable wrapped errors |

The Text style menu replaces H1 through H6 and P as separate buttons. The Insert menu replaces `+ Block` without changing its existing insert-after operation, then adds future Image and Video entries. Do not put Delete, Save, or Done in a generic overflow menu.

### Link editor

Move the URL input and its actions into a named popover or dialog so arrow keys stay available for toolbar navigation.

| Action | Presentation |
|---|---|
| Link URL | Persistent visible label plus URL input; do not rely on placeholder or `aria-label` alone |
| Apply link | Visible `Apply` text, optional `check` icon |
| Remove link | Visible `Remove` text, optional `unlink` icon; preserve disabled state when no link exists |
| Cancel | Visible `Cancel` text, optional `x` icon |
| Error | Keep an alert associated with the URL input |

### Frontmatter and media forms

Keep Page editor toggles, Edit frontmatter, frontmatter field labels, Save frontmatter, and Cancel as visible text. They are form controls, not dense toolbar actions.

Image and Video stay visible menu items, but their detailed actions belong in a form surface:

- Image: Choose file, destination name, alt text, Insert image, Cancel, then a clear edit, replace, or remove path.
- Video: Choose file, destination name, accessible label or nearby alternative, poster, controls, preload, muted, loop, autoplay constraints, Insert video, Cancel, then a clear edit, replace, or remove path.

## Label and tooltip policy

1. Give every button an accessible name on the button. Hide its SVG from assistive technology.
2. Keep visible text when the action is ambiguous, consequential, or form-like: Text style, Insert, Delete, Save, Done, menu items, and dialog actions.
3. Use icon-only presentation only for conventional compact editing actions: Undo, Bold, Italic, Link, Bullet list, and Numbered list.
4. Show a custom tooltip on hover and keyboard focus for every icon-only control. Use the action name, not the icon name, and append the shortcut when one exists.
5. Do not use a tooltip as the accessible name. Connect it as a description only when the shortcut adds useful information.
6. Make custom tooltips dismissible with `Esc`, hoverable, and persistent while hover or focus remains. Do not depend on tooltips for touch use.
7. Keep visible labels and accessible names aligned, for example visible `Delete` with accessible name `Delete block`.

## Responsive behavior

- Remove toolbar-level `overflow-x: auto`.
- Wrap complete `.toolbar-group` containers onto additional rows. Do not split controls inside a group unless the Format group itself must wrap at 320 CSS pixels.
- Keep each button target at least 44 by 44 CSS pixels and each icon near 20 by 20 pixels. Text buttons may grow wider.
- Let the toolbar use `max-width: calc(100vw - 16px)` and remeasure its height before placing it above or below the active block.
- Clamp menus, popovers, and validation messages inside the same 8px viewport inset.
- Preserve the same action order across widths. Do not move controls between primary and hidden overflow based only on width.
- At 320 CSS pixels, every action must be reachable without horizontal toolbar scrolling or page-level two-dimensional scrolling.

Wrapping is preferred over a generic More drawer because it preserves discovery and stable order. Text style and Insert remain menus because they are coherent families, not width-dependent overflow.

## Keyboard and accessibility constraints

- Keep `role="toolbar"` and its accessible label.
- `Alt+F10` enters the toolbar at the last focused enabled control, or the first enabled control on first entry.
- Use roving `tabindex`: one toolbar item is in the Tab order; Left and Right move through controls and wrap across rows; Home and End move to the first and last controls.
- `Tab` and `Shift+Tab` leave the toolbar. `Esc` closes a tooltip, menu, or link surface first, then returns to the active editable block or ends editing according to the current interaction.
- Use Up and Down inside open menus, not for the horizontal toolbar.
- Preserve existing direct shortcuts. Show shortcuts in tooltips or menu items.
- Expose Bold, Italic, and list states with `aria-pressed`; expose menus and popovers with `aria-expanded` and `aria-controls`.
- Keep focus visible, preserve forced-colors borders, maintain at least 3:1 non-text contrast, and never use color as the only danger, selection, disabled, or save-state cue.
- Test at 200% zoom and a 320 CSS pixel layout, with keyboard-only use, forced colors, and screen-reader role/name/state checks.

## Delivery test expectations

### Markup and unit tests

- Assert the exact icon and label map above, including decorative SVG treatment.
- Assert one Text style menu replaces seven block-type buttons.
- Assert Insert contains Paragraph below, Image, and Video entries, with unavailable future actions disabled or omitted until their delivery tasks land.
- Assert accessible names, pressed state, expanded state, disabled state, group order, and visible labels.
- Assert no toolbar action depends on a Unicode glyph or icon font.

### Playwright

- Enter with `Alt+F10`, navigate every enabled control with Left/Right and Home/End, execute with Enter/Space, leave with Tab, and return with `Esc`.
- Verify focus restoration after Text style, Insert, and Link close.
- Verify tooltip appearance on hover and focus, dismissal with `Esc`, and no focus trap.
- Verify Bold, Italic, lists, heading selection, link, undo, add paragraph, delete, save, and done retain behavior.
- Verify 320px and 400px widths, 200% zoom, long status/error text, link validation, and open menus without horizontal toolbar scrolling.
- Verify 44px targets, forced-colors boundaries, visible focus, screen-reader names, and name/role/state values.
- Keep planned image and video dialog tests in tasks #14 and #15, but reserve their Insert menu entries in the control map now.

## Strongest case against the recommendation

A contextual toolbar is a dense expert tool, the current 36px controls exceed WCAG 2.2 AA target size, and WCAG Reflow allows an exception for interfaces that need persistent toolbars. Replacing direct H1 through H6 buttons with a menu and adding roving focus increases actions and implementation complexity. If author testing shows frequent heading changes are slower or arrow navigation is less understandable, keep direct heading shortcuts and reconsider the Text style menu or roving behavior.

## Bias audit

| Bias | Risk | Fix applied |
|---|---|---|
| Confirmation | The task starts from the belief that redesign will help | Included the no-change and icon-only options, Carbon's familiar-icon exception, WCAG's toolbar reflow exception, and the cost of menus and roving focus |
| Availability | Public editor docs may not reflect user behavior in this small tool | Limited claims to documented interaction patterns and set falsifiers for Playwright and later author testing |
| Halo | Lucide's broad catalog could make it look automatically best | Compared licenses, package shape, accessibility guidance, and exact action coverage against Heroicons and Tabler |
| Overconfidence | Research cannot prove author recognition without usability testing | Framed the map as an implementation decision with measurable rejection conditions, not a proven usability outcome |
| Narrative | Grouping, icons, and accessibility could form an overly neat story | Recorded conflicting evidence and kept awkward exceptions: visible labels, a toolbar reflow exception, and form controls outside the icon system |

**Result:** pass after five bias controls. The evidence supports implementation, but author recognition remains an assumption to test.
