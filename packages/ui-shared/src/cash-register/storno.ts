/**
 * #145 / FR-21 — who may STORNO which sale. The server decides (`POST /trade/pos/session/:id/storno`);
 * this only decides whether to OFFER the button, and must never offer one the server refuses.
 *
 * Import-pure: the POS and invoicing journals, and a unit test, read it.
 */

/**
 * The roles the storno route accepts ("H4: Storno requires manager or admin role"). The server's
 * list (`invoicing-api/src/lib/cash-register-till.ts`) is the same.
 *
 * ⚠ Not `warehouse_manager` (owner, 2026-10-27): its permissions hold neither `pos.write` nor
 * `invoicing.write`, so it reached no storno door, and the list promised what it could not do.
 */
export const STORNO_ROLES = ['admin', 'manager'] as const

/**
 * A completed SALE (a POS row), by someone allowed to reverse it. A storno is not itself
 * reversible, and a cancelled sale is already reversed (or being reversed).
 */
export function canStornoTransaction(txn: { type?: string; status?: string } | null | undefined, role: string | undefined): boolean {
  if (!txn || !role) return false
  return txn.type === 'sale' && txn.status === 'completed' && (STORNO_ROLES as readonly string[]).includes(role)
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
 * entered in the back office, in either store (the server copies a POS row first).
 *
 * Not an imported till day: it is corrected by importing it again. Not an invoiced sale: an
 * invoice was issued for it, and the credit note to that invoice is its correction (a quantity is
 * corrected once, D-14).
 */
export function canStornoJournalRow(row: StornoableRow | null | undefined, role: string | undefined): boolean {
  if (!row || !role) return false
  return row.kind === 'sale'
    && row.status === 'completed'
    && (row.origin === 'pos' || row.origin === 'backoffice')
    && (row.invoicingState ?? 'none') === 'none'
    && (STORNO_ROLES as readonly string[]).includes(role)
}
