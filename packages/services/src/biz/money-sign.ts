/**
 * Which way a document's money goes, for anything that ADDS documents up (#447).
 *
 * A credit note and a till storno are stored with positive amounts, and both take money back: a note
 * from what its invoice owes or was paid, a storno from its sale (FR-21.9, FR-23 R2). Summed as they are
 * stored, a sale of 24 with a note of 12 reads 36. The digest's KPIs and sales history had learned that;
 * the contact's open balance, the invoice summary's outstanding, the list export and the digest's
 * documents had not, and disagreed with them on any day with a note.
 *
 * A debit note adds, like the invoice it corrects. A payment's receipt and a refund's storno are money
 * their own documents already count, and every reader here leaves them out before summing.
 */
export const NEGATIVE_MONEY_TYPES: readonly string[] = ['credit_note', 'cash_storno']

/** +1 or -1: what a document's stored amount counts for in a sum. */
export function moneySign(type: string | undefined | null): 1 | -1 {
  return type && NEGATIVE_MONEY_TYPES.includes(type) ? -1 : 1
}

/** The same rule inside an aggregation: `field` (an expression such as `'$total'`) with its sign. */
export function signedAmount(field: unknown): Record<string, unknown> {
  return { $cond: [{ $in: ['$type', [...NEGATIVE_MONEY_TYPES]] }, { $multiply: [field, -1] }, field] }
}
