/**
 * The colour of a journal row's kind, the same in the list and on the document. Import-pure.
 *
 * A sale is the green one and a storno the red one. A payment's receipt (FR-23) is neither: it is
 * money on an invoice, which is the sale.
 */
export function kindColor(kind: string | undefined): string {
  if (kind === 'storno') return 'error'
  return kind === 'payment' ? 'info' : 'success'
}
