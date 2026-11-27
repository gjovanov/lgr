/**
 * FR-28.27 (#933, #974): after an article is picked, the cursor goes to its line's quantity only while it is still
 * where the pick left it. A person who has moved on to another field keeps their cursor. One rule for the three forms
 * that move it:
 * - the stock count's Counted (`InventoryCountFormView#revealLine`, FR-33.6);
 * - an invoicing document's line quantity: invoice, bill, proforma, notes (`document-form/parts/products.ts`);
 * - a supplier order's line quantity (`OrderFormView#focusLineQuantity`).
 *
 * Where a pick leaves the cursor:
 * - **nowhere** (`<body>`): the field it was in is gone (the count's search field is replaced by a fresh one);
 * - **on the line the pick came from**, which each form names (`onPickLine`): the count's entry line, but not its
 *   fresh field; a document's or an order's line row, its own search field and Details button included (a pick from
 *   the field's list keeps the cursor in that field);
 * - **inside the dialog that delivered the pick, while it leaves.** "Add N articles" in Details is a click on a
 *   button, and the button keeps the cursor while the dialog runs its leave transition (Enter in the dialog's search
 *   does the same with the search field). Once the dialog is gone, the cursor falls to `<body>`. Measured in the field
 *   (#933): that button still held the cursor a second after the click, so a check that read it as "the person moved
 *   on" left the cursor on `<body>`. A closing overlay is one Vuetify no longer marks `v-overlay--active`.
 *
 * Anything else is a person's: the fresh search (the count's entry field, a document's next blank line), another
 * line, a field of the form, or an overlay that is open (a select's list, another dialog).
 */

/** What the rule reads of the focused element. A DOM `Element` is one. */
export interface CursorNode {
  readonly tagName: string
  closest(selectors: string): { readonly classList: { contains(token: string): boolean } } | null
}

/**
 * True while the cursor is where a pick left it, so the pick may move it to the line's quantity.
 * `active` is `document.activeElement`, `body` is `document.body`. `onPickLine` says whether a cursor outside any
 * overlay is on the line the pick came from, in the form's own terms.
 */
export function cursorWherePickLeft<T extends CursorNode>(active: T | null, body: unknown, onPickLine: (active: T) => boolean): boolean {
  if (!active || active === body) return true
  // The dialog that delivered the pick, on its way out: its button or its search field still holds the cursor.
  const overlay = active.closest('.v-overlay')
  if (overlay) return !overlay.classList.contains('v-overlay--active')
  return onPickLine(active)
}
