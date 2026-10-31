import { roundCents } from 'config/pos-totals'

/**
 * FR-23 §2.2 — what the fiscal receipt of a payment on an invoice says.
 *
 * - **A payment that settles the whole document as it is issued** prints its lines, like any sale,
 *   followed by a text line „Фактура № …".
 * - **Any other payment** prints one line per VAT rate, „Плащане по фактура № …", the amount split
 *   pro rata. The last one takes what is left, so the receipts add up to the document exactly, rate
 *   by rate.
 *
 * A fiscal device totals a receipt from VAT-inclusive prices, rounded to the cent per line. An
 * invoice is totalled another way (components first, `document-payload.ts`), and a bolt at 0.1234 net
 * sold in thousands is several units away from `quantity × rounded price`. A fiscal receipt must
 * say what the invoice says to the cent, so lines the device would add up differently are not
 * printed as lines: such a payment prints the per-rate shape, which is exact by construction. So does
 * a device with no text line inside a fiscal receipt, and the number is then the line's name.
 *
 * The wording is Bulgarian on every org's receipt, as the device's own text is. The accountant
 * confirms it against Н-18 (Q-3).
 *
 * Import-pure: the receipt's document, the freeze and their unit tests all read it.
 */

/**
 * The VAT-inclusive unit price a fiscal device must be given. Document lines carry NET prices; a
 * device derives VAT from the gross amount per group, so sending the net price would print, and
 * book, every line without its VAT.
 */
export function fiscalUnitPrice(netUnitPrice: number, taxRate: number | undefined): number {
  return roundCents(netUnitPrice * (1 + (taxRate || 0) / 100))
}

export interface RateShare {
  rate: number
  gross: number
}

interface SourceLine {
  productId?: unknown
  description?: string
  quantity?: number
  unit?: string
  unitPrice?: number
  discount?: number
  taxRate?: number
  taxAmount?: number
  lineTotal?: number
}

export interface ReceiptSource {
  type?: string
  invoiceNumber?: string
  total?: number
  discountTotal?: number
  lines?: SourceLine[]
}

/** A line as a cash-register document stores it: net price, gross `lineTotal` (FR-21.5). */
export interface ReceiptLine {
  productId?: unknown
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
}

export interface ReceiptBody {
  lines: ReceiptLine[]
  /** Printed under the lines, when the lines themselves do not name the document. */
  receiptText?: string
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
}

const num = (v: unknown) => Number(v) || 0
const toCents = (v: number) => Math.round(num(v) * 100)
const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0)

/**
 * `cents` shared out in proportion to `weights`, to the cent, largest remainder first. Whole
 * numbers, so nothing is lost to the floats. Null when a weight is negative or nothing weighs.
 */
export function apportion(weights: number[], cents: number): number[] | null {
  if (weights.some(w => w < 0)) return null
  const whole = sum(weights)
  if (whole <= 0) return null
  const exact = weights.map(w => (w * cents) / whole)
  const shares = exact.map(x => Math.floor(x + 1e-9))
  let left = cents - sum(shares)
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x + 1e-9) })).sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    shares[i]++
    left--
  }
  return shares
}

/**
 * The document's money per VAT rate, adding up to its total exactly. A line's `lineTotal` is gross
 * on every invoice-side document (FR-21.5); lines and total can still differ by rounding, and the
 * total is what is owed, so it is shared out in the lines' proportions.
 */
export function grossByRate(doc: ReceiptSource): RateShare[] | null {
  const byRate = new Map<number, number>()
  for (const l of doc.lines || []) {
    const rate = num(l.taxRate)
    byRate.set(rate, (byRate.get(rate) || 0) + num(l.lineTotal))
  }
  const rates = [...byRate.keys()]
  const shares = apportion(rates.map(r => toCents(byRate.get(r)!)), toCents(num(doc.total)))
  return shares && rates.map((rate, i) => ({ rate, gross: shares[i] / 100 }))
}

/** What the receipts already printed took, per rate: their lines' gross. */
export function receiptedByRate(receipts: { lines?: SourceLine[] }[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of receipts) {
    for (const l of r.lines || []) out.set(num(l.taxRate), (out.get(num(l.taxRate)) || 0) + toCents(num(l.lineTotal)))
  }
  return out
}

/**
 * `amount` per VAT rate, out of what is left of each rate. Pro rata; a payment of all that is left
 * takes it as it stands, so the rounding of the earlier ones is made good and the receipts add up
 * to the document exactly. Null when the money cannot be split: a rate with a negative total.
 */
export function splitByRate(gross: RateShare[], receipted: Map<number, number>, amount: number): RateShare[] | null {
  const left = gross.map(g => Math.max(0, toCents(g.gross) - (receipted.get(g.rate) || 0)))
  const cents = toCents(amount)
  if (sum(left) < cents) return null
  const shares = sum(left) === cents ? left : apportion(left, cents)
  return shares && gross.map((g, i) => ({ rate: g.rate, gross: shares[i] / 100 })).filter(s => s.gross > 0)
}

/** What a device adds this line up to: its rounded price times the quantity, less the discount. */
function deviceAmount(l: SourceLine): number {
  const gross = roundCents(fiscalUnitPrice(num(l.unitPrice), num(l.taxRate)) * Number(num(l.quantity).toFixed(3)))
  return l.discount ? roundCents(gross - roundCents((gross * num(l.discount)) / 100)) : gross
}

/**
 * Whether the device, given these lines, comes to exactly the document's money, rate by rate, and
 * will take them at all: it refuses a quantity or a price below zero, and a discount of 100 %.
 */
export function printsExactly(doc: ReceiptSource, gross: RateShare[]): boolean {
  const lines = doc.lines || []
  if (!lines.length || !lines.every(l => num(l.quantity) > 0 && num(l.unitPrice) >= 0 && Math.abs(num(l.discount)) <= 99)) return false
  return gross.every(g => toCents(sum(lines.filter(l => num(l.taxRate) === g.rate).map(deviceAmount))) === toCents(g.gross))
}

const noun = (doc: ReceiptSource) => (doc.type === 'debit_note' ? 'дебитно известие' : 'фактура')
const capitalized = (s: string) => s[0].toUpperCase() + s.slice(1)

/** „Фактура № …": the document, as a text line or as the name of a line. */
export function documentText(doc: ReceiptSource): string {
  return `${capitalized(noun(doc))} № ${doc.invoiceNumber}`
}

/** „Плащане по фактура № …". */
export function paymentText(doc: ReceiptSource): string {
  return `Плащане по ${noun(doc)} № ${doc.invoiceNumber}`
}

/** One receipt line carrying `gross` at `rate`. VAT comes out of the gross, as a device takes it out. */
function rateLine(description: string, share: RateShare): ReceiptLine {
  const taxAmount = roundCents((share.gross * share.rate) / (100 + share.rate))
  return {
    description,
    quantity: 1,
    unit: 'бр.',
    // Unrounded, so that `fiscalUnitPrice` gives the device exactly this gross back.
    unitPrice: Math.round((share.gross / (1 + share.rate / 100)) * 1e6) / 1e6,
    discount: 0,
    taxRate: share.rate,
    taxAmount,
    lineTotal: share.gross,
  }
}

/** The document's lines as a receipt carries them, without what ties them to orders and sales. */
function asReceiptLine(l: SourceLine): ReceiptLine {
  return {
    ...(l.productId ? { productId: l.productId } : {}),
    description: String(l.description ?? ''),
    quantity: num(l.quantity),
    unit: l.unit || 'бр.',
    unitPrice: num(l.unitPrice),
    discount: num(l.discount),
    taxRate: num(l.taxRate),
    taxAmount: num(l.taxAmount),
    lineTotal: num(l.lineTotal),
  }
}

export interface ReceiptBodyInput {
  doc: ReceiptSource
  amount: number
  /** The whole document, paid as it is issued. */
  whole: boolean
  /** The device can print a text line inside a fiscal receipt. */
  printsText: boolean
  /** The receipts already printed or printing for this document. */
  receipts: { lines?: SourceLine[] }[]
}

/** What the receipt of `amount` on `doc` prints. Null when the money cannot be split per rate. */
export function receiptBody(input: ReceiptBodyInput): ReceiptBody | null {
  const { doc, amount, whole, printsText, receipts } = input
  const gross = grossByRate(doc)
  if (!gross) return null

  if (whole && printsText && printsExactly(doc, gross)) {
    const lines = (doc.lines || []).map(asReceiptLine)
    const taxTotal = roundCents(sum(lines.map(l => l.taxAmount)))
    const discountTotal = roundCents(num(doc.discountTotal))
    return {
      lines, receiptText: documentText(doc), taxTotal, discountTotal, total: amount,
      subtotal: roundCents(amount - taxTotal + discountTotal),
    }
  }

  const shares = splitByRate(gross, receiptedByRate(receipts), amount)
  if (!shares?.length) return null
  const name = whole ? documentText(doc) : paymentText(doc)
  const lines = shares.map(s => rateLine(name, s))
  const taxTotal = roundCents(sum(lines.map(l => l.taxAmount)))
  return { lines, taxTotal, discountTotal: 0, total: amount, subtotal: roundCents(amount - taxTotal) }
}

/**
 * FR-23 §2.7: whether an edit would move what the document's receipts printed: its total, its money
 * at any VAT rate, or the currency all of that is in.
 */
export function movesPrintedMoney(
  doc: ReceiptSource & { currency?: string },
  edit: { total?: number; currency?: string; lines?: SourceLine[] },
): boolean {
  if (edit.total !== undefined && toCents(edit.total) !== toCents(num(doc.total))) return true
  if (edit.currency !== undefined && doc.currency && edit.currency !== doc.currency) return true
  if (edit.lines === undefined) return false
  const perRate = (lines: SourceLine[]) => {
    const out = new Map<number, number>()
    for (const l of lines) out.set(num(l.taxRate), (out.get(num(l.taxRate)) || 0) + num(l.lineTotal ?? lineGross(l)))
    return out
  }
  const before = perRate(doc.lines || [])
  const after = perRate(edit.lines)
  // A cent's slack: a form that totals a line again may round it its own way, and the total above
  // is compared exactly.
  return [...new Set([...before.keys(), ...after.keys()])].some(r => Math.abs(toCents(before.get(r) || 0) - toCents(after.get(r) || 0)) > 1)
}

/** A line sent without its total, as `POST /invoices` computes one. */
function lineGross(l: SourceLine): number {
  const net = num(l.quantity) * num(l.unitPrice) * (1 - num(l.discount) / 100)
  return net * (1 + num(l.taxRate) / 100)
}
