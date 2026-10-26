/**
 * #145 / FR-21 — who may STORNO which sale. The server decides (`POST /trade/pos/session/:id/storno`);
 * this only decides whether to OFFER the button, and must never offer one the server refuses.
 *
 * Import-pure: the POS and invoicing journals, and a unit test, read it.
 */

/** The roles the storno route accepts ("H4: Storno requires manager or admin role"). */
export const STORNO_ROLES = ['admin', 'manager', 'warehouse_manager'] as const

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
}

/**
 * A row of the journal that the till can reverse today: a completed till sale still held as a POS
 * row. A till sale already held as a cash-register document is reversed by R2's storno; a
 * back-office or imported sale has no fiscal receipt to reverse (FR-21 §3.5, R2).
 */
export function canStornoJournalRow(row: StornoableRow | null | undefined, role: string | undefined): boolean {
  if (!row || !role) return false
  return row.kind === 'sale'
    && row.status === 'completed'
    && row.origin === 'pos'
    && row.store === 'pos'
    && (STORNO_ROLES as readonly string[]).includes(role)
}
