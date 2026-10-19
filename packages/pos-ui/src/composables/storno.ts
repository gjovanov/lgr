/**
 * #145 — who may STORNO which POS transaction. The server decides (`POST /session/:id/storno`);
 * this only decides whether to OFFER the button, and must never offer one the server refuses.
 */

/** The roles the storno route accepts ("H4: Storno requires manager or admin role"). */
export const STORNO_ROLES = ['admin', 'manager', 'warehouse_manager'] as const

/**
 * A completed SALE, by someone allowed to reverse it. A storno is not itself reversible, and a
 * cancelled sale is already reversed (or being reversed).
 */
export function canStornoTransaction(txn: { type?: string; status?: string } | null | undefined, role: string | undefined): boolean {
  if (!txn || !role) return false
  return txn.type === 'sale' && txn.status === 'completed' && (STORNO_ROLES as readonly string[]).includes(role)
}
