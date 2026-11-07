import { apportion, deviceTaxTotal, deviceTotals, grossByRate, roundCents, vatOf, type RateShare } from 'config/pos-totals'
import { withLineAmounts } from '../document-amounts.js'

// The share rules live with the totals (`config/pos-totals`), where the screens read them too (#554).
export { apportion, deviceTaxTotal, deviceTotals, grossByRate, vatOf, type RateShare }

/**
 * FR-23 §2.2 — what the fiscal receipt of a payment on an invoice says.
 *
 * - **A payment that settles the whole document as it is issued** prints its lines, like any sale,
 *   followed by a text line „Фактура № …".
 * - **Any other payment** prints one line per VAT rate, „Плащане по фактура № …", the amount split
 *   pro rata. The last one takes what is left, so the receipts add up to the document exactly, rate
 *   by rate.
 *
 * A fiscal device totals a receipt from VAT-inclusive prices, rounded to the cent per line. A
 * document is totalled another way (components first, `document-payload.ts`, `computePosTotals`), and a
 * bolt at 0.1234 net sold in thousands is several units away from `quantity × rounded price`. A fiscal
 * receipt must say what the document says to the cent, so lines the device would add up differently are
 * not printed as lines: such a payment prints the per-rate shape, which is exact by construction. So does
 * a device with no text line inside a fiscal receipt, and the number is then the line's name. A till sale
 * and its storno, whole or in part, go by the same rule (`linesOnDevice`).
 *
 * The wording is Bulgarian on every org's receipt, as the device's own text is (Q-3). A line name
 * has to survive the device: a driver that cuts one (a Tremol, at 34) would otherwise cut the number,
 * and the receipt would name another document or none, so the longest wording that fits whole prints.
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

const NOUNS: Record<string, string> = { debit_note: 'дебитно известие', credit_note: 'кредитно известие', cash_sale: 'продажба' }
const noun = (doc: ReceiptSource) => NOUNS[String(doc.type)] ?? 'фактура'
const capitalized = (s: string) => s[0].toUpperCase() + s.slice(1)

/** The first wording that fits whole, then the number alone: it is what must never be cut. */
const firstThatFits = (wordings: string[], max: number | undefined) =>
  wordings.find(w => max === undefined || w.length <= max) ?? wordings[wordings.length - 1]

/** „Фактура № …": the document, as a text line or as the name of a line. */
export function documentText(doc: ReceiptSource, max?: number): string {
  return firstThatFits([`${capitalized(noun(doc))} № ${doc.invoiceNumber}`, `№ ${doc.invoiceNumber}`, String(doc.invoiceNumber)], max)
}

/** „Плащане по фактура № …". */
export function paymentText(doc: ReceiptSource, max?: number): string {
  return firstThatFits([`Плащане по ${noun(doc)} № ${doc.invoiceNumber}`, documentText(doc, max)], max)
}

/** „Връщане по кредитно известие № …": what a refund's storno prints (R2). */
export function refundText(doc: ReceiptSource, max?: number): string {
  return firstThatFits([`Връщане по ${noun(doc)} № ${doc.invoiceNumber}`, documentText(doc, max)], max)
}

/** One receipt line carrying `gross` at `rate`. VAT comes out of the gross, as a device takes it out. */
function rateLine(description: string, share: RateShare): ReceiptLine {
  const taxAmount = vatOf(share)
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

/**
 * What a device is given for this document: the one rule, for a sale, a storno of it, whole or in part, and a
 * receipt's money (the prod sweep's D2). Where prices at the device's precision reproduce the document's gross
 * per rate, its lines print as they are. Where they do not, one line per rate at the exact gross, called `name`,
 * so the device comes to the document to the cent, with no change shown and no cash added to close it, and a storno
 * to what it reverses. The document keeps its articles: only the receipt says less.
 *
 * Null from `grossByRate` is a rate with a negative total, which no device takes either way: the lines go as they
 * are, and the driver refuses them with the reason. Fastener prices are normal here, so this is the common case.
 */
export function linesOnDevice(doc: ReceiptSource, name: string): SourceLine[] {
  const gross = grossByRate(doc)
  if (!gross || printsExactly(doc, gross)) return doc.lines ?? []
  const perRate = gross.filter(g => g.gross > 0).map(g => rateLine(name, g))
  // A document that comes to nothing has no money to give a line: its own lines, for the driver to say.
  return perRate.length ? perRate : doc.lines ?? []
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
  /** The longest line name the device keeps, when its driver cuts one. */
  nameMax?: number
}

/** What the receipt of `amount` on `doc` prints. Null when the money cannot be split per rate. */
export function receiptBody(input: ReceiptBodyInput): ReceiptBody | null {
  const { doc, amount, whole, printsText, receipts, nameMax } = input
  const gross = grossByRate(doc)
  if (!gross) return null

  if (whole && printsText && printsExactly(doc, gross)) {
    const lines = (doc.lines || []).map(asReceiptLine)
    // Each line keeps its own VAT. The receipt's is the device's, out of each rate's gross (#554): two lines at
    // 0.125 net and 20 % carry 0.03 each, and the device takes 0.05 out of their 0.30.
    const taxTotal = roundCents(sum(gross.map(vatOf)))
    const discountTotal = roundCents(num(doc.discountTotal))
    return {
      lines, receiptText: documentText(doc), taxTotal, discountTotal, total: amount,
      subtotal: roundCents(amount - taxTotal + discountTotal),
    }
  }

  const shares = splitByRate(gross, receiptedByRate(receipts), amount)
  if (!shares?.length) return null
  const name = whole ? documentText(doc, nameMax) : paymentText(doc, nameMax)
  const lines = shares.map(s => rateLine(name, s))
  const taxTotal = roundCents(sum(lines.map(l => l.taxAmount)))
  return { lines, taxTotal, discountTotal: 0, total: amount, subtotal: roundCents(amount - taxTotal) }
}

/**
 * FR-23 R2 — what the storno of a refund prints: one line per VAT rate, naming the credit note, whole or
 * in part. A refund can span receipts and a device takes any lines on a storno, so the money is exact by
 * construction and the receipt it cites is on its header, not in its lines.
 */
export function refundBody(doc: ReceiptSource, take: Map<number, number>, nameMax?: number): ReceiptBody {
  const name = refundText(doc, nameMax)
  const lines = [...take].map(([rate, cents]) => rateLine(name, { rate, gross: cents / 100 }))
  const total = roundCents(sum(lines.map(l => l.lineTotal)))
  const taxTotal = roundCents(sum(lines.map(l => l.taxAmount)))
  return { lines, taxTotal, discountTotal: 0, total, subtotal: roundCents(total - taxTotal) }
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
    // A line sent or stored without its total counts as `POST` and `PUT` would total it.
    for (const l of lines) out.set(num(l.taxRate), (out.get(num(l.taxRate)) || 0) + num(withLineAmounts(l).lineTotal))
    return out
  }
  const before = perRate(doc.lines || [])
  const after = perRate(edit.lines)
  // A cent's slack: a form that totals a line again may round it its own way, and the total above
  // is compared exactly.
  return [...new Set([...before.keys(), ...after.keys()])].some(r => Math.abs(toCents(before.get(r) || 0) - toCents(after.get(r) || 0)) > 1)
}
