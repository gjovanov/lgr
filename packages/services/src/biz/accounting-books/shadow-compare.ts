/**
 * FR-25 R3, slice 3: the dry run's self-check. A shadow posting against the accountant's entry for the same document,
 * per account, analytic and side, in the SAME org (R7: a store's books hold its own series' sales, so the two name the
 * same partner and group analytics by the same ids). Import-pure. Counts only reach the output.
 *
 * What a difference is called, by the accounts it is on (a document can differ in several):
 *   - revenue  `K702` / `K703`: the nets, or how they split between goods and services;
 *   - vat      `K4532`;
 *   - cost     `D702`, and `K304` per group, amount or quantity;
 *   - partner  `D411` / `K411` per analytic, where their sums agree: the same money on another customer;
 *   - cash     `D501`, or `K411` in total: what was paid at issue;
 *   - other    any other account either side books.
 */

export interface ComparedLine {
  account: string
  analyticId?: string
  side: 'debit' | 'credit'
  amount: number
  quantity?: number
}

export const DIFFERENCES = ['revenue', 'vat', 'cost', 'partner', 'cash', 'other'] as const
export type Difference = (typeof DIFFERENCES)[number]

export interface CostSpread {
  /** Within half a percent of the books' cost. */
  within05: number
  within5: number
  more: number
}

const KNOWN = new Set(['702', '703', '4532', '304', '411', '501'])
const near = (a: number, b: number) => Math.abs(a - b) < 0.005
const nearQty = (a: number, b: number) => Math.abs(a - b) < 1e-6

/** Sums per `account|analytic|side`, and quantities per the same key. */
function sums(lines: readonly ComparedLine[]) {
  const amount = new Map<string, number>()
  const quantity = new Map<string, number>()
  for (const l of lines) {
    const key = `${l.account}|${l.analyticId ?? ''}|${l.side}`
    amount.set(key, (amount.get(key) ?? 0) + (Number(l.amount) || 0))
    if (l.quantity !== undefined && l.quantity !== null) quantity.set(key, (quantity.get(key) ?? 0) + (Number(l.quantity) || 0))
  }
  return { amount, quantity }
}

const total = (lines: readonly ComparedLine[], account: string, side: 'debit' | 'credit') =>
  lines.filter(l => l.account === account && l.side === side).reduce((s, l) => s + (Number(l.amount) || 0), 0)

/** How a shadow posting differs from the books' entry (or entries) of its document: nothing when they are equal. */
export function differencesOf(shadow: readonly ComparedLine[], books: readonly ComparedLine[]): Set<Difference> {
  const out = new Set<Difference>()
  const a = sums(shadow)
  const b = sums(books)
  const differs = (key: string) => !near(a.amount.get(key) ?? 0, b.amount.get(key) ?? 0) || !nearQty(a.quantity.get(key) ?? 0, b.quantity.get(key) ?? 0)
  const keys = [...new Set([...a.amount.keys(), ...b.amount.keys()])]
  for (const key of keys) {
    if (!differs(key)) continue
    const [account, , side] = key.split('|')
    if (!KNOWN.has(account)) out.add('other')
    else if ((account === '702' || account === '703') && side === 'credit') out.add('revenue')
    else if (account === '4532') out.add('vat')
    else if ((account === '702' && side === 'debit') || account === '304') out.add('cost')
    else if (account === '501') out.add('cash')
    else if (account === '411') {
      // The customer's account: in total, it is the money (the nets, the VAT, the cash); per analytic only, the partner.
      const sameTotal = near(total(shadow, '411', side as 'debit' | 'credit'), total(books, '411', side as 'debit' | 'credit'))
      out.add(sameTotal ? 'partner' : side === 'credit' ? 'cash' : 'revenue')
    } else out.add('other')
  }
  return out
}

/** The cost a posting books: its `D702`, signed. */
export const costOf = (lines: readonly ComparedLine[]) => total(lines, '702', 'debit')

/** Where a document's cost difference falls, relative to the books' cost. */
export function spreadOf(shadowCost: number, booksCost: number): keyof CostSpread {
  const rel = Math.abs(shadowCost - booksCost) / Math.max(Math.abs(booksCost), 0.01)
  return rel <= 0.005 ? 'within05' : rel <= 0.05 ? 'within5' : 'more'
}
