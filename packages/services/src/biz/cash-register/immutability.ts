/**
 * FR-21.11 (D-8) — a cash-register document with a fiscal identity is never edited, deleted or
 * voided; it is corrected by a storno.
 *
 * A POS transaction has always been immutable, but only because no route could change it. As a
 * document in `invoices` it sits behind routes that can — `PUT /invoices/:id` edits any document
 * in any status (commit 1429c0a) — so they refuse it here, from R1 on: before any such document
 * exists, so that a rollback from R2 to R1 still protects the ones R2 wrote.
 *
 * What it covers: a till sale or storno (`register.origin: 'pos'`), every `cash_storno`, every
 * `payment_receipt` and `payment_storno` (FR-23), and any sale a storno has claimed or reversed
 * (`register.stornoState: 'full'`). Other back-office and imported cash sales keep today's rules;
 * FR-20.51 owns those.
 *
 * ⚠ A back-office sale can be stornoed from the journal since R2. Its storno already returned the
 * goods and counts its total negative, so a void (which reverses the dispatch) or a delete on top
 * would reverse the sale a second time.
 *
 * Import-pure.
 */

export const REGISTER_DOCUMENT_IMMUTABLE = {
  code: 'register_document_immutable',
  message: 'This cash-register document cannot be edited, deleted or voided. Correct it with a storno.',
} as const

export function isImmutableRegisterDocument(
  doc: { type?: string; register?: { origin?: string; stornoState?: string } } | null | undefined,
): boolean {
  return !!doc && (doc.type === 'cash_storno' || doc.type === 'payment_receipt' || doc.type === 'payment_storno' || doc.register?.origin === 'pos' || doc.register?.stornoState === 'full')
}
