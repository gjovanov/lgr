/**
 * #145 / FR-21 — who may STORNO which sale. The server decides (`POST /trade/pos/session/:id/storno`);
 * this only decides whether to OFFER the button, and must never offer one the server refuses.
 *
 * Import-pure: the POS and invoicing journals, and a unit test, read it.
 */

import { can, compileLegacy, type Grant } from 'config/access'

/**
 * The roles the storno route accepts ("H4: Storno requires manager or admin role"). Since FR-27 (#529) both sides
 * ask the grant for `cash-sales.storno`, which today's roles give as this list says.
 *
 * ⚠ Not `warehouse_manager` (owner, 2026-10-27): its permissions hold neither `pos.write` nor
 * `invoicing.write`, so it reached no storno door, and the list promised what it could not do.
 */
export const STORNO_ROLES = ['admin', 'manager'] as const

/**
 * Who asks: the session's grant (FR-27.5: in an org on `roles`, the role's, live, as the server's
 * `can(user, 'cash-sales.storno')` decides), or a legacy role key, read as that role's own capabilities.
 */
export type StornoActor = string | Grant | null | undefined

/** FR-27: whether this session may reverse a sale (`cash-sales.storno`). */
function mayStorno(who: StornoActor): boolean {
  if (!who) return false
  return can(typeof who === 'string' ? compileLegacy({ role: who }) : who, 'cash-sales.storno')
}

/**
 * A completed SALE (a POS row), by someone allowed to reverse it. A storno is not itself
 * reversible, and a cancelled sale is already reversed (or being reversed).
 */
export function canStornoTransaction(txn: { type?: string; status?: string; isFiscal?: boolean; fiscal?: { state?: string } } | null | undefined, role: StornoActor): boolean {
  if (!txn || !role) return false
  // FR-23: nothing can prove its fiscal receipt printed, so a person settles it first.
  if (txn.isFiscal && (txn.fiscal?.state === 'unknown' || txn.fiscal?.state === 'pending')) return false
  return txn.type === 'sale' && txn.status === 'completed' && mayStorno(role)
}

/**
 * Whether the storno dialog offers a part beside all of it (FR-23 R3): when there is anything to pick. One line of one
 * unit or less counts: an article sold by the kilo goes back 0.3 of 0.8. Only the smallest quantity a device prints has
 * no part to it.
 */
export function canPickPart(lines: { left: number }[]): boolean {
  const open = lines.filter(l => l.left > 0)
  return open.length > 1 || (open.length === 1 && open[0].left > 0.001)
}

/** A journal row (`/cash-register/documents`), as the shared journal shows it. */
export interface StornoableRow {
  kind?: string
  status?: string
  origin?: string
  store?: string
  /** #171: how far an invoice covers the sale. */
  invoicingState?: string
}

/**
 * A row of the journal a storno can reverse (FR-21 §3.5): a completed sale, rung up at the till or
 * entered in the back office, in either store (the server copies a POS row first), or what is left of a
 * partly stornoed one (FR-23 R3).
 *
 * Not an imported till day: it is corrected by importing it again. Not an invoiced sale: an
 * invoice was issued for it, and the credit note to that invoice is its correction (a quantity is
 * corrected once, D-14).
 */
export function canStornoJournalRow(row: StornoableRow | null | undefined, role: StornoActor): boolean {
  if (!row || !role) return false
  // `inDoubt` is a status of its own: a person settles it first, and the server refuses until then.
  return row.kind === 'sale'
    && (row.status === 'completed' || row.status === 'partial')
    && (row.origin === 'pos' || row.origin === 'backoffice')
    && (row.invoicingState ?? 'none') === 'none'
    && mayStorno(role)
}
