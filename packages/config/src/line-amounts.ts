/**
 * A document line's money as the document forms compute it (`invoicing-ui … document-payload.ts`), and, since #573,
 * as the server stores a cash sale entered in the back office. A cash sale's line amounts are the proportions its
 * total is shared out by per VAT rate (`grossByRate`), on its receipt and in the VAT it books, so they are the
 * server's to compute: they used to be whatever the request carried.
 *
 * Import-pure: the forms and the server both read it.
 */

/** What a line is sold on. Anything a form field can hold: blank or not a number counts as 0. */
export interface LineTerms {
  quantity?: unknown
  unitPrice?: unknown
  discount?: unknown
  taxRate?: unknown
}

export interface LineAmounts {
  net: number
  discountAmount: number
  taxable: number
  taxAmount: number
  total: number
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return isNaN(v) ? 0 : v
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

/** The `+(x).toFixed(2)` rounding the forms use. */
const round2 = (v: number): number => +num(v).toFixed(2)

/**
 * Per-line raw (unrounded) amounts.
 * - discount-aware (sales invoice, proforma, credit and debit notes): taxable =
 *   net − net·discount%, then tax.
 * - non-discount (purchase invoice, cash sale): legacy expressions reproduced exactly
 *   (`qty·price·rate/100` and `qty·price·(1 + rate/100)`).
 */
export function lineAmounts(l: LineTerms, hasDiscount: boolean): LineAmounts {
  const net = num(l.quantity) * num(l.unitPrice)
  if (hasDiscount) {
    const discountAmount = net * (num(l.discount) / 100)
    const taxable = net - discountAmount
    const taxAmount = taxable * (num(l.taxRate) / 100)
    return { net, discountAmount, taxable, taxAmount, total: taxable + taxAmount }
  }
  const taxAmount = net * num(l.taxRate) / 100
  return { net, discountAmount: 0, taxable: net, taxAmount, total: net * (1 + num(l.taxRate) / 100) }
}

/**
 * #573 — a back-office cash sale's line as the server stores it: its VAT and its gross `lineTotal`, each rounded on
 * its own, exactly as the cash-sale form sends them (no discount). A discount, which only an API client sends, comes
 * off the way the discount-aware forms take it, so the line's gross is the money its terms ask for.
 */
export function cashSaleLineAmounts(l: LineTerms): { taxAmount: number; lineTotal: number } {
  const a = lineAmounts(l, num(l.discount) !== 0)
  return { taxAmount: round2(a.taxAmount), lineTotal: round2(a.total) }
}
