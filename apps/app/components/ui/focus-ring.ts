/**
 * The one focus indicator, expressed once.
 *
 * WCAG 2.1 SC 2.4.7 is satisfied by a 2 px outline at a 2 px offset drawn in
 * the accent token, and the offset gap is what makes the indicator adjacent to
 * the page surface even on a filled control — which is the pair the contrast
 * gate in `src/theme/check-contrast.ts` measures for SC 1.4.11.
 *
 * `styles/theme.css` already applies this to every `:focus-visible` element
 * from the tokens. Each interactive primitive restates it in its own class
 * list so the indicator survives a page that resets outlines, and so the
 * indicator is visible in the component source rather than only in the theme.
 *
 * Two rules hold everywhere under this directory, and `test/ui.test.mjs`
 * enforces both:
 *
 *   1. no primitive ever removes an outline — the class that would do so, and
 *      the declaration that would do so, appear nowhere;
 *   2. the indicator is only ever applied under `:focus-visible`, so a pointer
 *      press does not draw it.
 *
 * Requirements: 24.10
 */

/** Outline width, offset, and colour, all drawn from theme tokens. */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" as const;

/**
 * The same indicator for a control whose own focus lands on a child element,
 * such as a wrapper around a native form control.
 */
export const FOCUS_RING_WITHIN =
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring" as const;
