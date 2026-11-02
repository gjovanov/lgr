/**
 * FR-23 §2.5, #363 — what a storno of a till sale gives back, line by line. One customer brings one of three
 * articles back, and a second storno brings the next.
 *
 * Each line of a sale is worth a share of what the sale printed at its VAT rate (`printedByRate`), to the cent, so
 * all of its lines add up to the receipt exactly. A part of a line is read off its running total (`partOfLine`),
 * so the parts add up to the line in whatever pieces they come back. The whole sale, in any number of stornos,
 * comes to what it printed: no rounding is left on the device or in the drawer.
 *
 * Quantities are in thousandths of a unit, as a device prints them, and money in cents, as the budget is. What was
 * taken lives on the sale: `register.stornoClaims` per line, `register.refundClaims` per rate, in one atomic update
 * (`claimForStorno`). A line's budget is what it sold less what live stornos took; one in doubt keeps what it took,
 * and one that did not print gives it back.
 *
 * Import-pure but for `printedByRate`'s module: it reads no database.
 */
import { partOfLine, roundCents } from 'config/pos-totals'
import { apportion } from './receipt-lines.js'
import { printedByRate, type ByRate } from './refund-budget.js'

const toCents = (v: unknown) => Math.round((Number(v) || 0) * 100)
const toMilli = (v: unknown) => Math.round((Number(v) || 0) * 1000)

/**
 * A line of a sale, as a claim and an API name it. ⚠ A sale copied raw from an old POS row has lines with no `_id`.
 * Nothing edits a till sale, so its position in the document names it just as well.
 */
export const lineKey = (line: any, index: number): string => (line?._id ? String(line._id) : `#${index}`)

export interface SaleLine {
  key: string
  index: number
  rate: number
  sold: number
  returned: number
  left: number
  /** What the whole line is worth, in cents. */
  value: number
}

/** What each storno claim took of each line. */
export function returnedByLine(sale: any): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of sale?.register?.stornoClaims ?? []) out.set(String(c.lineId), (out.get(String(c.lineId)) || 0) + (Number(c.milli) || 0))
  return out
}

/** The sale's lines that sold anything, each with its budget and its worth. */
export function saleLines(sale: any): SaleLine[] {
  const returned = returnedByLine(sale)
  const printed = printedByRate(sale)
  const all = (sale?.lines ?? []).map((l: any, index: number) => ({ l, index, rate: Number(l.taxRate) || 0 }))
  const worth = new Map<number, number>()
  for (const rate of new Set<number>(all.map((x: any) => x.rate))) {
    const here = all.filter((x: any) => x.rate === rate)
    const shares = apportion(here.map((x: any) => toCents(x.l.lineTotal)), printed.get(rate) || 0)
    here.forEach((x: any, i: number) => worth.set(x.index, shares?.[i] ?? 0))
  }
  return all
    .filter(({ l }: any) => Number(l.quantity) > 0)
    .map(({ l, index, rate }: any) => {
      const key = lineKey(l, index)
      const sold = toMilli(l.quantity)
      const back = returned.get(key) || 0
      return { key, index, rate, sold, returned: back, left: Math.max(0, sold - back), value: worth.get(index) || 0 }
    })
}

export interface PlannedLine {
  key: string
  index: number
  rate: number
  milli: number
  /** What it gives back, in cents. */
  cents: number
}

export interface StornoPlan {
  /** Not the whole sale in one go: the storno carries its own lines and its own money. */
  partial: boolean
  /** After this one nothing of the sale is left. */
  completes: boolean
  lines: PlannedLine[]
  /** Per VAT rate, in cents: what it takes from the receipt's budget. */
  want: ByRate
  /** Every line's `returned` as this read it. The claim goes ahead only on the sale as it read it. */
  read: Map<string, number>
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
}

export interface PlanRefusal {
  statusCode: number
  body: Record<string, unknown>
}

/** A document's money for what it gives back: VAT out of the gross per rate, as a device takes it out. */
function moneyOf(sale: any, lines: PlannedLine[]) {
  const byRate = new Map<number, number>()
  let discountTotal = 0
  for (const p of lines) {
    byRate.set(p.rate, (byRate.get(p.rate) || 0) + p.cents)
    const l = sale.lines[p.index]
    discountTotal += ((p.milli / 1000) * (Number(l.unitPrice) || 0) * (Number(l.discount) || 0)) / 100
  }
  let total = 0
  let taxTotal = 0
  for (const [rate, cents] of byRate) {
    total += cents
    taxTotal += roundCents(((cents / 100) * rate) / (100 + rate))
  }
  total = total / 100
  taxTotal = roundCents(taxTotal)
  discountTotal = roundCents(discountTotal)
  return { byRate, total, taxTotal, discountTotal, subtotal: roundCents(total - taxTotal + discountTotal) }
}

/**
 * What a storno would take of this sale as it stands, or why it cannot. `asked`: which lines and how much; none
 * is all that is left. What it finds here is checked again where it counts, in the claim.
 */
export function planStorno(sale: any, asked?: { lineId: string; quantity: number }[]): StornoPlan | PlanRefusal {
  const lines = saleLines(sale)
  const read = new Map(lines.map(l => [l.key, l.returned]))
  const untouched = lines.every(l => !l.returned) && !sale?.register?.refundClaims?.length
  let wanted: Map<string, number>
  if (asked?.length) {
    wanted = new Map()
    for (const a of asked) {
      const line = lines.find(l => l.key === String(a.lineId))
      if (!line) return { statusCode: 422, body: { code: 'storno_line_unknown', lineId: a.lineId, message: `Line ${a.lineId} is not a line of this sale that sold anything.` } }
      const milli = (Number(a.quantity) || 0) * 1000
      if (!(milli > 0) || Math.abs(milli - Math.round(milli)) > 1e-6) {
        return { statusCode: 422, body: { code: 'storno_quantity_invalid', lineId: a.lineId, message: 'A quantity to return is above 0, in at most three decimals.' } }
      }
      wanted.set(line.key, (wanted.get(line.key) || 0) + Math.round(milli))
    }
    const over = lines.filter(l => (wanted.get(l.key) || 0) > l.left)
    if (over.length) {
      return {
        statusCode: 409,
        body: {
          code: 'storno_exceeds_left',
          lines: over.map(l => ({ lineId: l.key, left: l.left / 1000, requested: (wanted.get(l.key) || 0) / 1000 })),
          message: 'More than is left of this sale to return: another storno took part of it. Nothing was reversed.',
        },
      }
    }
  } else {
    wanted = new Map(lines.filter(l => l.left > 0).map(l => [l.key, l.left]))
  }
  const planned: PlannedLine[] = lines
    .filter(l => wanted.get(l.key))
    .map(l => ({ key: l.key, index: l.index, rate: l.rate, milli: wanted.get(l.key)!, cents: partOfLine(l.value, l.sold, l.returned, wanted.get(l.key)!) }))
  const completes = lines.every(l => (wanted.get(l.key) || 0) >= l.left)
  // The whole sale in one go is its own figures, as a storno has always carried them.
  if (untouched && completes) {
    return {
      partial: false, completes, lines: planned, want: printedByRate(sale), read,
      subtotal: Number(sale.subtotal) || 0, discountTotal: Number(sale.discountTotal) || 0, taxTotal: Number(sale.taxTotal) || 0, total: Number(sale.total) || 0,
    }
  }
  const { byRate, total, taxTotal, discountTotal, subtotal } = moneyOf(sale, planned)
  return { partial: true, completes, lines: planned, want: byRate, read, subtotal, discountTotal, taxTotal, total }
}

/**
 * The filter that lets a claim through only on the sale as it read it: every line's `returned` what the plan found.
 * So a part's money is read off a running total nobody moved, and the state it writes is the truth: two stornos
 * of two lines at once, each reading the other's line as untouched, would each write `partial` with the sale all back.
 */
export function asPlanRead(read: Map<string, number>): unknown[] {
  const claims = { $ifNull: ['$register.stornoClaims', []] }
  return [...read].map(([key, returned]) => ({
    $eq: [
      { $sum: { $map: { input: { $filter: { input: claims, cond: { $eq: ['$$this.lineId', key] } } }, in: '$$this.milli' } } },
      returned,
    ],
  }))
}

export const isPlanRefusal = (p: StornoPlan | PlanRefusal): p is PlanRefusal => 'statusCode' in p

/** A line of a storno that returns part of a sale: the sale's line, for what comes back. */
export function stornoLine(sale: any, p: PlannedLine): Record<string, unknown> {
  const { _id, cashSaleLineId, ...line } = sale.lines[p.index]
  const gross = p.cents / 100
  return { ...line, quantity: p.milli / 1000, lineTotal: gross, taxAmount: roundCents((gross * p.rate) / (100 + p.rate)) }
}

export interface MethodLeft {
  method: string
  cents: number
}

/**
 * What the sale still holds per method: what it kept, less what live stornos gave back by that method. In the sale's
 * own order. A storno the operator paid back another way can take a method below nothing, which is none.
 */
export function leftByMethod(sale: any, stornos: { status?: string; payments?: { method?: string; amount?: number }[] }[]): MethodLeft[] {
  const kept = sale.payments?.length ? sale.payments : [{ method: sale.paymentMethod || 'cash', amount: sale.total }]
  const left = new Map<string, number>()
  for (const p of kept) left.set(String(p.method), (left.get(String(p.method)) || 0) + toCents(p.amount))
  for (const s of stornos) {
    if (s.status === 'voided') continue
    for (const p of s.payments ?? []) if (left.has(String(p.method))) left.set(String(p.method), left.get(String(p.method))! - toCents(p.amount))
  }
  return [...left].map(([method, cents]) => ({ method, cents: Math.max(0, cents) }))
}

/**
 * How a part goes back when the operator names no method. ⚠ One method when one still holds all of it, the first the
 * sale names: a device prints one payment type on a storno for the whole amount, so that is the case where the
 * device, the drawer and the card terminal all agree. Larger than any one, it draws on them in the sale's order,
 * and what is left past them falls on the first. So the last part of a split sale gives each method back the rest.
 */
export function refundOfPart(left: MethodLeft[], cents: number): { method: string; amount: number }[] {
  const whole = left.find(m => m.cents >= cents)
  if (whole) return [{ method: whole.method, amount: cents / 100 }]
  const out: { method: string; cents: number }[] = []
  let rest = cents
  for (const m of left) {
    const take = Math.min(m.cents, rest)
    if (take > 0) out.push({ method: m.method, cents: take })
    rest -= take
  }
  if (rest > 0) {
    if (out.length) out[0].cents += rest
    else out.push({ method: left[0]?.method ?? 'cash', cents: rest })
  }
  return out.map(m => ({ method: m.method, amount: m.cents / 100 }))
}
