/**
 * What the record-payment dialog suggests (FR-22.7) — the pure part, no Vue, unit-tested in
 * `packages/tests/src/unit/payment-defaults.test.ts`.
 *
 * The dialog used to suggest the whole total and a bank transfer whatever the document said: it
 * read a `paidAmount` the API does not have (the field is `amountPaid`), so a partly paid invoice
 * offered to be paid in full again, and a card sale had its method picked a second time.
 */

export interface PayableDoc {
  total?: number
  amountPaid?: number
  paymentMethod?: string
}

/** What is still to be paid: the total less what has been paid on it, never below zero. */
export function outstandingAmount(doc: PayableDoc | null | undefined): number {
  const due = (Number(doc?.total) || 0) - (Number(doc?.amountPaid) || 0)
  return Math.max(0, Math.round(due * 100) / 100)
}

/**
 * The method the document says it is paid by, when the dialog offers it. Otherwise a bank
 * transfer, which is what the dialog always used to start with.
 */
export function defaultPaymentMethod(doc: PayableDoc | null | undefined, offered: readonly string[]): string {
  const method = doc?.paymentMethod
  if (method && offered.includes(method)) return method
  return offered.includes('bank_transfer') ? 'bank_transfer' : offered[0] || ''
}
