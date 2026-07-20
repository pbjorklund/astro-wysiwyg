# Editor toolbar source excerpts

Fetched 2026-07-20. Excerpts preserve the source wording, with whitespace normalized.

## CKEditor 5: Editor toolbars

- Organization: CKSource
- Date: undated live documentation
- URL: https://ckeditor.com/docs/ckeditor5/latest/getting-started/setup/toolbar.html
- Status: HTTP 200, retrieved directly

> The toolbar is the most basic user interface element of CKEditor 5 that gives you convenient access to all its features. It has buttons and dropdowns that you can use to format, manage, insert, and change elements of your content.

> You can use '|' to create a separator between groups of toolbar items. This works in both the basic and extended configuration formats.

> If there are more toolbar items than can fit in the toolbar in the current display width, some items get hidden. You can access them by clicking the show more items button.

> To save space in your toolbar or arrange the features thematically, you can group several items into a dropdown.

The documented example orders `undo`, `redo`, `heading`, font controls, inline styles, `link`, `uploadImage`, block controls, and lists in separated groups. It also documents wrapping as an alternative to automatic grouping.

## TinyMCE: Options for customizing the editor's toolbars

- Organization: Tiny Technologies
- Date: undated live documentation
- URL: https://www.tiny.cloud/docs/tinymce/latest/toolbar-configuration-options/
- Status: HTTP 200, retrieved directly

> To create groups within this list, please add | pipe characters between the groups of buttons that you would like to create.

> toolbar: 'undo redo | styles | bold italic | link image'

> The toolbar_mode option is used to extend the toolbar to accommodate the overflowing toolbar buttons. This option is useful for small screens or small editor frames.

> When there are two or more toolbar button groups, the main toolbar will show as many complete, sequential toolbar groups as possible within the width of the editor. Any remaining toolbar button groups will be moved to the toolbar drawer.

> The scrolling toolbar mode is intended for touch screen devices.

> If the toolbar_mode is configured to wrap, the overflow toolbar buttons will be shown on one or more toolbars below the primary toolbar.

## WordPress: Work with blocks

- Organization: WordPress.org
- Date: live documentation, current page
- URL: https://wordpress.org/documentation/article/work-with-blocks/
- Status: HTTP 200, retrieved directly

> The block toolbar appears when you select a block. It includes essentials tools for editing, formatting, moving, or changing the selected block. The options you see depend on the block you select. Some blocks have many toolbar options, while others only have a few.

> Many toolbar controls appear as icons. To learn what an icon does, hover over it or move keyboard focus to it to see the control label. Screen reader users can navigate through the toolbar to hear each control name.

> This control appears as three vertical dots.

> By default, the block toolbar appears near the selected block. You can also choose to display the toolbar at the top of the editor.

## WordPress: Image block

- Organization: WordPress.org
- Date: live documentation, current page
- URL: https://wordpress.org/documentation/article/image-block/
- Status: HTTP 200, retrieved directly

> After adding the Image block, you have a few options to choose to get started.

> Upload an image or video from your device.

> After uploading or selecting an image, customize the image details in your Media Library, such as the Title, Caption, Alt Text, and Description. This data is helpful for SEO, accessibility, and helps you search for files in your media library.

> Each block has its own block-specific controls that allow you to manipulate the block right in the editor.

## Tiptap: Custom menu

- Organization: Tiptap
- Date: undated live documentation
- URL: https://tiptap.dev/docs/editor/getting-started/style-editor/custom-menus
- Status: HTTP 200, retrieved directly

> Make sure users can navigate the menu with their keyboard.

> Use title attributes.

> Use ARIA attributes.

> List available keyboard shortcuts.

> Most editor menus use icons for their buttons.

## CKEditor 5: Accessibility support

- Organization: CKSource
- Date: undated live documentation
- URL: https://ckeditor.com/docs/ckeditor5/latest/features/accessibility.html
- Status: HTTP 200, retrieved directly

> Keyboard support is enabled by default for all editor types and core editor features.

The keyboard table documents `Alt+F10` to move focus to the toolbar, arrow keys to navigate it, `Enter` or `Space` to execute, and `Esc` to close contextual balloons, dropdowns, and dialogs.

## TinyMCE: Accessible navigation guide

- Organization: Tiny Technologies
- Date: undated live documentation
- URL: https://www.tiny.cloud/docs/tinymce/latest/tinymce-and-screenreaders/
- Status: HTTP 200, retrieved directly

> To focus on the editor toolbars, press Alt+F10 (or Option+F10); which moves the keyboard focus to the first toolbar button on the first toolbar.

> To move between toolbar buttons within toolbar groups (visual groups of toolbar buttons), use the Left Arrow and Right Arrow keys.

> To move the focus between toolbar groups, use the Tab or Shift+Tab keys.

> To return focus to the content area from the toolbar, use the Esc key.

## Fetch failures

None. Every listed URL returned HTTP 200 and topic-matching article text.

> Editorial analysis is in `../../overview.md`.
