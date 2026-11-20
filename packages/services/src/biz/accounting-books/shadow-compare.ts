/**
 * FR-25 R3, slice 3: the dry run's self-check. A shadow posting against the accountant's entry for the same document,
 * per account, analytic and side, in the SAME org (R7: a store's books hold its own series' sales, so the two name the
 * same partner and group analytics by the same ids). Import-pure. Counts only reach the output.
 *
 * Equal means every (account, analytic, side) carries the same amount to the cent, and the same quantity. A document
 * that is not equal is counted under every place it differs in, by totals, so each place means one thing:
 *   - revenue  `K702` or `K703`, in total: the nets, or how they split between goods and services;
 *   - vat      `K4532`, in total;
 *   - cost     `D702` in total, or `K304` per group in amount or quantity. Split further: `groups` when the
 *              quantities per group differ (the map put a product in another group), `average` when they agree and
 *              only the amounts do (the books' average differs from the one the posting took);
 *   - partner  the analytics on `411` differ: another customer, whatever the amounts;
 *   - cash     `D501`, or `K411`, in total: what was paid at issue;
 *   - other    an account the sales rules do not book, on either side; or a difference none of the above explains
 *              (an analytic on 702, a `D411` total that the nets and the VAT do not account for).
 * Every document that differs is in at least one place.
 */
import {
  CASH_ACCOUNT, CUSTOMERS_ACCOUNT, GOODS_ACCOUNT, GOODS_REVENUE_ACCOUNT, SERVICES_REVENUE_ACCOUNT, VAT_OUTPUT_ACCOUNT,
} from './registry.js'

export interface ComparedLine {
  account: string
  analyticId?: string
  side: 'debit' | 'credit'
  amount: number
  quantity?: number
}

export const DIFFERENCES = ['revenue', 'vat', 'cost', 'partner', 'cash', 'other'] as const
export type Difference = (typeof DIFFERENCES)[number]

/** Of a cost that differs, why: the quantities per group, or the amounts only. */
export type CostDifference = 'groups' | 'average'

export interface Differences {
  places: Set<Difference>
  /** Set when `places` has `cost`. */
  cost?: CostDifference
}

export interface CostSpread {
  /** Within half a percent of the books' cost. */
  within05: number
  within5: number
  more: number
}

const KNOWN = new Set([GOODS_ACCOUNT, CUSTOMERS_ACCOUNT, VAT_OUTPUT_ACCOUNT, CASH_ACCOUNT, GOODS_REVENUE_ACCOUNT, SERVICES_REVENUE_ACCOUNT])
const cents = (v: number) => Math.round((Number(v) || 0) * 100)
const qty = (v: number) => Math.round((Number(v) || 0) * 1e6)

type Side = ComparedLine['side']
const keyOf = (account: string, analyticId: string | undefined, side: Side) => `${account}|${analyticId ?? ''}|${side}`

/** Cents and millionths of a unit per `account|analytic|side`, zero sums dropped. */
function sums(lines: readonly ComparedLine[]) {
  const amount = new Map<string, number>()
  const quantity = new Map<string, number>()
  for (const l of lines) {
    const key = keyOf(l.account, l.analyticId, l.side)
    amount.set(key, (amount.get(key) ?? 0) + cents(l.amount))
    if (l.quantity !== undefined && l.quantity !== null) quantity.set(key, (quantity.get(key) ?? 0) + qty(l.quantity))
  }
  for (const m of [amount, quantity]) for (const [k, v] of m) if (!v) m.delete(k)
  return { amount, quantity }
}

/** In cents, so a document's sums compare exactly. */
const total = (lines: readonly ComparedLine[], account: string, side: Side) =>
  lines.filter(l => l.account === account && l.side === side).reduce((s, l) => s + cents(l.amount), 0)

const analyticsOn = (lines: readonly ComparedLine[], account: string) =>
  JSON.stringify([...new Set(lines.filter(l => l.account === account && cents(l.amount)).map(l => l.analyticId ?? ''))].sort())

/** How a shadow posting differs from the books' entry (or entries) of its document: no places when they are equal. */
export function differencesOf(shadow: readonly ComparedLine[], books: readonly ComparedLine[]): Differences {
  const a = sums(shadow)
  const b = sums(books)
  const keys = new Set([...a.amount.keys(), ...b.amount.keys(), ...a.quantity.keys(), ...b.quantity.keys()])
  const differing = [...keys].filter(k => (a.amount.get(k) ?? 0) !== (b.amount.get(k) ?? 0) || (a.quantity.get(k) ?? 0) !== (b.quantity.get(k) ?? 0))
  const places = new Set<Difference>()
  if (!differing.length) return { places }

  const totalDiffers = (account: string, side: Side) => total(shadow, account, side) !== total(books, account, side)
  if (totalDiffers(GOODS_REVENUE_ACCOUNT, 'credit') || totalDiffers(SERVICES_REVENUE_ACCOUNT, 'credit')) places.add('revenue')
  if (totalDiffers(VAT_OUTPUT_ACCOUNT, 'credit')) places.add('vat')

  const groupKeys = differing.filter(k => k.startsWith(`${GOODS_ACCOUNT}|`))
  let cost: CostDifference | undefined
  if (totalDiffers(GOODS_REVENUE_ACCOUNT, 'debit') || groupKeys.length) {
    places.add('cost')
    const quantitiesOn = (s: ReturnType<typeof sums>) => JSON.stringify([...s.quantity].filter(([k]) => k.startsWith(`${GOODS_ACCOUNT}|`)).sort())
    cost = quantitiesOn(a) !== quantitiesOn(b) ? 'groups' : 'average'
  }
  if (analyticsOn(shadow, CUSTOMERS_ACCOUNT) !== analyticsOn(books, CUSTOMERS_ACCOUNT)) places.add('partner')
  if (totalDiffers(CASH_ACCOUNT, 'debit') || totalDiffers(CUSTOMERS_ACCOUNT, 'credit')) places.add('cash')

  const elsewhere = differing.some(k => !KNOWN.has(k.split('|')[0]))
  // The customer is debited the nets and the VAT: a total that differs while they agree is money booked elsewhere.
  const unexplained = totalDiffers(CUSTOMERS_ACCOUNT, 'debit') && !places.has('revenue') && !places.has('vat')
  if (elsewhere || unexplained || !places.size) places.add('other')
  return { places, ...(cost ? { cost } : {}) }
}

/** The cost a posting books: its `D702`, signed. */
export const costOf = (lines: readonly ComparedLine[]) => total(lines, GOODS_REVENUE_ACCOUNT, 'debit') / 100

/** Where a document's cost difference falls, relative to the books' cost. */
export function spreadOf(shadowCost: number, booksCost: number): keyof CostSpread {
  const rel = Math.abs(shadowCost - booksCost) / Math.max(Math.abs(booksCost), 0.01)
  return rel <= 0.005 ? 'within05' : rel <= 0.05 ? 'within5' : 'more'
}
