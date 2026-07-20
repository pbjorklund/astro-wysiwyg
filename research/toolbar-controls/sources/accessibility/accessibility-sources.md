# Accessibility and design-system source excerpts

Fetched 2026-07-20. Excerpts preserve the source wording, with whitespace normalized.

## WAI-ARIA Authoring Practices Guide: Toolbar pattern

- Organization: W3C Web Accessibility Initiative
- Date: live APG documentation
- URL: https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/
- Status: HTTP 200, retrieved directly

> A toolbar is a container for grouping a set of controls, such as buttons, menubuttons, or checkboxes.

> Implement focus management so the keyboard tab sequence includes one stop for the toolbar and arrow keys move focus among the controls in the toolbar.

> In toolbars with multiple rows of controls, Left Arrow and Right Arrow can provide navigation that wraps from row to row, leaving the option of reserving vertical arrow keys for operating controls.

> Avoid including controls whose operation requires the pair of arrow keys used for toolbar navigation. If unavoidable, include only one such control and make it the last element in the toolbar.

> Use toolbar as a grouping element only if the group contains 3 or more controls.

## WAI-ARIA Authoring Practices Guide: Toolbar example

- Organization: W3C Web Accessibility Initiative
- Date: 2025-08-12 on the search result
- URL: https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/examples/toolbar/
- Status: HTTP 200, retrieved directly

> The following example of an editor toolbar implements the Toolbar Pattern and demonstrates how a toolbar can group a set of interactive widgets into a single tab stop.

> When tabbing into the toolbar, focus returns to the control that last had focus.

> Left Arrow and Right Arrow navigate among elements in the toolbar.

> The bold, italic, underline, and text align buttons have popup labels that implement the requirements of WCAG Success Criterion 1.4.13 Content on Hover or Focus.

> The popup label remains visible when the pointer hovers over the label content. Pressing Esc hides the popup label.

The example also keeps some disabled controls focusable when discoverability matters. The main toolbar pattern says disabled controls are typically not focusable, so this is an explicit design choice rather than a universal rule.

## WCAG 2.2 Understanding 2.5.8: Target Size (Minimum)

- Organization: W3C Web Accessibility Initiative
- Date: current WCAG 2.2 understanding document
- URL: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
- Status: HTTP 200, retrieved directly

> The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except when:

> The intent of this success criterion is to help ensure targets can be easily activated without accidentally activating an adjacent target.

> The requirement is for targets to be at least 24 by 24 CSS pixels in size. There are five exceptions.

The document's icon-button example says 24 by 24 targets pass. It also says 20 by 20 targets with 4 CSS pixels between them can pass the spacing exception, while the same targets without space fail.

## WCAG 2.2 Understanding 1.4.10: Reflow

- Organization: W3C Web Accessibility Initiative
- Date: current WCAG 2.2 understanding document
- URL: https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
- Status: HTTP 200, retrieved directly

> Content can be presented without loss of information or functionality, and without requiring scrolling in two dimensions for: Vertical scrolling content at a width equivalent to 320 CSS pixels.

> Examples of content which requires two-dimensional layout are images required for understanding (such as maps and diagrams), video, games, presentations, data tables (not individual cells), and interfaces where it is necessary to keep toolbars in view while manipulating content.

> Although there is an exception for sections of content that require two-dimensional layout for understanding or functionality, authors can improve the user's experience by making efforts to reduce scrolling for that type of content.

> Modern websites and applications commonly employ responsive web design best practices to adjust or relocate sections of content to fit within smaller viewports.

## WCAG 2.2 Understanding 1.4.13: Content on Hover or Focus

- Organization: W3C Web Accessibility Initiative
- Date: current WCAG 2.2 understanding document
- URL: https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
- Status: HTTP 200, retrieved directly

> Custom tooltips, sub-menus, and other nonmodal popups that display on hover and focus are examples of additional content covered by this criterion.

> There are usually more predictable and accessible means of adding content to the page, which authors are recommended to employ.

> If an author does choose to make additional content appear and disappear in coordination with hover and keyboard focus, this success criterion specifies three conditions that must be met: dismissible, hoverable, persistent.

The document notes that browser tooltips created by the HTML `title` attribute are controlled by the user agent and outside this criterion.

## Carbon Design System: Tooltip accessibility

- Organization: IBM Carbon Design System
- Date: live documentation
- URL: https://carbondesignsystem.com/components/tooltip/accessibility/
- Status: HTTP 200, retrieved directly

> Every icon-only button needs a tooltip, except for icons with clearly established names or functions (such as Bold and Italics).

> The tooltip is triggered by hover or focus of the icon button.

> The content should be actionable, short, and concise. It should describe the icon's action, not the icon itself.

## Carbon Design System: Icons usage

- Organization: IBM Carbon Design System
- Date: live documentation
- URL: https://carbondesignsystem.com/elements/icons/usage/
- Status: HTTP 200, retrieved directly

> All touch targets for interactive icons need to be 44px or larger. Developers can add padding to a touch target with CSS to meet the 44px requirement.

> A 22px icon centered in a 48px touch target.

## GitLab Pajamas: Button

- Organization: GitLab Pajamas Design System
- Date: live documentation
- URL: https://design.gitlab.com/components/button
- Status: HTTP 200, retrieved directly

> Icon-only buttons must have an accessible name. You can provide one with the aria-label attribute, which is read out by screen readers.

> For icon-only buttons, add a tooltip to describe the action.

## GitLab Pajamas: Iconography

- Organization: GitLab Pajamas Design System
- Date: live documentation
- URL: https://design.gitlab.com/product-foundations/iconography
- Status: HTTP 200, retrieved directly

> Simple and concise. Design to minimize time to comprehension.

> Using an icon consistently to represent a single concept or action helps with overall learnability for a user.

> There are, however, several icons whose design doesn't match a single metaphor, but multiple. In these cases, meaning must be provided in context.

> In addition to context, ensure that aria-label attributes and/or tooltips are used to communicate the icon meaning.

> If an icon is not accompanied by a label or its use isn't clear based on the immediately surrounding context, then provide a quick explanation in a tooltip.

## Fetch failures

- Material Design 3 icon-button accessibility returned an HTTP 200 application shell with no article text. Patchright, shot-scraper, and stealth screenshot fallbacks loaded the visual page but did not expose the guidance text reliably enough for a quote. The source was excluded from the synthesis.
- Every source used in the synthesis returned HTTP 200 and topic-matching article text.

> Editorial analysis is in `../../overview.md`.
