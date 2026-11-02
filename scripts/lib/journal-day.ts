import { givesBack } from '../../packages/ui-shared/src/cash-register/journal-kind'

/**
 * The cash a day's journal rows leave in the drawers, which the fleet check holds against the sessions. What
 * gives money back counts against it: a till's storno and a refund's. Nothing voided counts, and neither does
 * what is held in doubt, which has booked nothing. ⚠ But for a sale: its money stands whatever a person says
 * of its receipt (D-4), and its session has counted it.
 */
export function cashKeptOf(rows: { kind?: string; status?: string; fiscal?: { inDoubt?: boolean }; payments: { method: string; amount: number }[] }[]): number {
  let cash = 0
  for (const r of rows) {
    if (r.status === 'voided' || (r.fiscal?.inDoubt && r.kind !== 'sale')) continue
    const sign = givesBack(r.kind) ? -1 : 1
    for (const p of r.payments) if (p.method === 'cash') cash += sign * p.amount
  }
  return Math.round(cash * 100) / 100
}
