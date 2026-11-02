/**
 * The colour of a journal row's kind, the same in the list and on the document. Import-pure.
 *
 * A sale is the green one and a storno the red one. A payment's receipt (FR-23) is neither: it is
 * money on an invoice, which is the sale. A refund's storno is money going back on a credit note.
 */
export function kindColor(kind: string | undefined): string {
  if (kind === 'storno') return 'error'
  if (kind === 'refund') return 'warning'
  return kind === 'payment' ? 'info' : 'success'
}

/** What a row gives back rather than takes: it reads negative wherever money is shown. */
export const givesBack = (kind: string | undefined) => kind === 'storno' || kind === 'refund'
