/**
 * The amounts a document's request may leave out, and what its lines make them: each line's VAT and
 * gross total, and the document's VAT and total in the base currency. One rule, for both doors:
 * `POST /invoices` and `PUT /invoices/:id`.
 *
 * ⚠ A `PUT` replaces `lines` with what it was sent, through `findOneAndUpdate`, which runs no validator:
 * the model's `required` on a line's `taxAmount` and `lineTotal` never fires there. Lines sent with
 * neither were stored with neither. The PDF prints them at 0.00 and a receipt finds no money to split
 * (`grossByRate`), under a header that still reads right.
 *
 * Import-pure: the freeze (`receipt-lines.ts`) reads a line's total from here too.
 */

export interface AmountLine {
  quantity?: number
  unitPrice?: number
  discount?: number
  taxRate?: number
  taxAmount?: number
  lineTotal?: number
  unit?: string
  description?: string
}

export interface AmountsBody {
  lines?: AmountLine[]
  subtotal?: number
  discountTotal?: number
  taxTotal?: number
  /** `taxTotal` under the name some API clients send it. */
  taxAmount?: number
  total?: number
  totalBase?: number
  exchangeRate?: number
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
/** The `+(x).toFixed(2)` rounding the document forms use (`document-payload.ts`). */
const round2 = (v: number) => +num(v).toFixed(2)
const toCents = (v: unknown) => Math.round(num(v) * 100)

/** What a line's numbers make it, unrounded. */
function reckon(l: AmountLine): { net: number; discount: number; tax: number } {
  const net = num(l.quantity) * num(l.unitPrice)
  const discount = net * (num(l.discount) / 100)
  return { net, discount, tax: (net - discount) * (num(l.taxRate) / 100) }
}

/**
 * A line as the model wants it stored. `lineTotal` is gross, as a form's is (FR-21.5). What the client
 * sent stands: an imported line's `lineTotal` is net.
 */
export function withLineAmounts<L extends AmountLine>(l: L): L & { unit: string; description: string; taxAmount: number; lineTotal: number } {
  const { net, discount, tax } = reckon(l)
  return {
    ...l,
    unit: l.unit || 'pcs',
    description: l.description || '',
    taxAmount: l.taxAmount ?? round2(tax),
    lineTotal: l.lineTotal ?? round2(net - discount + tax),
  }
}

/** Document totals of lines, components rounded first (as `computeTotals` does). */
export function invoiceTotalsOf(lines: AmountLine[]): { subtotal: number; discountTotal: number; taxTotal: number; total: number } {
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0
  for (const l of lines) {
    const { net, discount, tax } = reckon(l)
    subtotal += net
    discountTotal += discount
    taxTotal += tax
  }
  const s = round2(subtotal)
  const d = round2(discountTotal)
  const t = round2(taxTotal)
  return { subtotal: s, discountTotal: d, taxTotal: t, total: round2(s - d + t) }
}

/** What the request said the VAT is, or the sum of its lines': theirs where they sent it, what their numbers make where not. */
function taxTotalOf(body: AmountsBody): number {
  return body.taxTotal ?? body.taxAmount ?? round2((body.lines || []).reduce((s, l) => s + (l.taxAmount ?? reckon(l).tax), 0))
}

/** What a new document leaves out. */
export function documentAmounts(body: AmountsBody) {
  return {
    lines: (body.lines || []).map(withLineAmounts),
    taxTotal: taxTotalOf(body),
    totalBase: body.totalBase ?? round2(num(body.total) * (body.exchangeRate || 1)),
  }
}

/** A line's money, as the terms it is sold on: its amounts are what these make them. */
const termsOf = (lines: AmountLine[]) =>
  lines.map(l => [num(l.quantity), num(l.unitPrice), num(l.discount), num(l.taxRate)].join('|')).sort().join(';')

/**
 * What an edit leaves out. Every line it sends is stored whole; the header only follows what moved.
 *
 * ⚠ Lines sent with the terms they already have change nothing. A form sends all its lines on every
 * save, and an imported document's `taxTotal` and `totalBase` are the PDF's, where its lines' rounded VAT
 * can sum a cent or two away: a person saving a note must not move them.
 */
export function editedAmounts(existing: { lines?: AmountLine[]; total?: number; exchangeRate?: number }, body: AmountsBody): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let total = body.total
  if (body.lines) {
    out.lines = body.lines.map(withLineAmounts)
    if (termsOf(body.lines) !== termsOf(existing.lines || [])) {
      const taxTotal = taxTotalOf(body)
      out.taxTotal = taxTotal
      // A total nobody sent cannot stay what it was: the base, the receipts' freeze and what is due all read it.
      if (total === undefined) {
        const reckoned = invoiceTotalsOf(body.lines)
        const subtotal = body.subtotal ?? reckoned.subtotal
        const discountTotal = body.discountTotal ?? reckoned.discountTotal
        total = round2(subtotal - discountTotal + taxTotal)
        Object.assign(out, { subtotal, discountTotal, total })
      }
    }
  }
  const before = existing.exchangeRate || 1
  const rate = body.exchangeRate || before
  if (body.totalBase === undefined && ((total !== undefined && toCents(total) !== toCents(existing.total)) || rate !== before)) {
    out.totalBase = round2(num(total ?? existing.total) * rate)
  }
  return out
}
