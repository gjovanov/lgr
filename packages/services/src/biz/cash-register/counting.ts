/**
 * FR-21.1 — how a cash-register sale counts, in every reader that sums them.
 *
 *   A sale counts whether or not it was stornoed; a storno counts negative; nothing voided counts.
 *
 * In `POSTransaction` terms a sale is flipped to `cancelled` by exactly one thing: its storno (a
 * storno whose receipt failed gives the sale back, #145). So a reader that skipped `cancelled`
 * rows AND subtracted the storno took the sale out twice — the session journal entry and the sales
 * history both did (FR-21 B-1). A storno row is `cancelled` only when its receipt failed, which
 * reversed nothing, so it does not count.
 *
 * `return` and `exchange` rows are legacy: the terminal never sends them. They keep the sign they
 * always had, and count only while `completed`.
 *
 * Import-pure: the journal handler, the reports and their unit tests all read it.
 */

export interface PosRowLike {
  type?: string
  status?: string
}

/** +1, −1 or 0: what a POS row contributes to a sum of sales. */
export function posRowSign(row: PosRowLike): 1 | -1 | 0 {
  switch (row.type) {
    case 'sale':
      return 1
    case 'storno':
    case 'return':
      return row.status === 'completed' ? -1 : 0
    case 'exchange':
      return row.status === 'completed' ? 1 : 0
    default:
      return 0
  }
}

export interface MethodTotals {
  cash: number
  card: number
  other: number
}

const cents = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/**
 * What a row left in the drawer, per method, before its sign: card and other as they were paid,
 * and cash as the rest of the total, because change only ever goes back in cash.
 *
 * - **A sale** paid 50 in cash for 37.20 kept 37.20, not the 50 tendered. Summing the tendered
 *   amount (what `payments` holds) made the session JE debit change the till had handed back.
 * - **A storno** carries the sale's own payments when the operator gives no refund payments, so
 *   this mirrors the sale it reverses: the card part goes back to the card, the rest in cash. That
 *   is the rule `stornoRefundBuckets` applies to the session's totals.
 *
 * The three always add up to the row's total — card and other are capped at what is left — so a
 * journal entry built from them balances by construction.
 */
export function keptByMethod(row: { total?: number; payments?: { method?: string; amount?: number }[] }): MethodTotals {
  const total = cents(row.total ?? 0)
  let card = 0
  let other = 0
  for (const p of row.payments || []) {
    const amount = Number(p?.amount) || 0
    if (p?.method === 'cash') continue
    if (p?.method === 'card') card += amount
    else other += amount
  }
  card = Math.min(Math.max(0, cents(card)), Math.max(0, total))
  other = Math.min(Math.max(0, cents(other)), Math.max(0, cents(total - card)))
  return { cash: cents(total - card - other), card, other }
}
