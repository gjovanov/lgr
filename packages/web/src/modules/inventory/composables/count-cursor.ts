/**
 * FR-33.6 / FR-28.27 (#933): after a pick on the stock count, the cursor goes to the line's Counted only while it is
 * still where the pick left it. A person who has moved on to another field keeps their cursor.
 *
 * Where a pick leaves the cursor:
 * - **nowhere** (`<body>`): the search's field is replaced by a fresh one, so the cursor that was in it is gone;
 * - **on the entry line, not in its field**: its Details button;
 * - **inside the dialog that delivered the pick, while it leaves.** "Add N articles" is a click on a button, and the
 *   button keeps the cursor while the dialog runs its leave transition (Enter in the dialog's search does the same with
 *   the search field). Once the dialog is gone, the cursor falls to `<body>`. Measured in the field (#933): that button
 *   still held the cursor a second after the click, so a check that read it as "the person moved on" left the cursor
 *   on `<body>`. A closing overlay is one Vuetify no longer marks `v-overlay--active`.
 *
 * Anything else is a person's: the fresh entry field (already finding the next article), another line, a field of the
 * form, or an overlay that is open (a select's list, another dialog).
 */

/** What the rule reads of the focused element. A DOM `Element` is one. */
export interface CursorNode {
  readonly tagName: string
  closest(selectors: string): { readonly classList: { contains(token: string): boolean } } | null
}

/** The entry line's row (`CountEntryLine.vue`). */
export const COUNT_ENTRY_SELECTOR = '[data-testid="count-entry"]'

/**
 * True while the cursor is where a pick left it, so the pick may move it to the line's Counted.
 * `active` is `document.activeElement`, `body` is `document.body`.
 */
export function cursorWherePickLeft(active: CursorNode | null, body: unknown): boolean {
  if (!active || active === body) return true
  // The dialog that delivered the pick, on its way out: its button or its search field still holds the cursor.
  const overlay = active.closest('.v-overlay')
  if (overlay) return !overlay.classList.contains('v-overlay--active')
  return !!active.closest(COUNT_ENTRY_SELECTOR) && active.tagName !== 'INPUT'
}
