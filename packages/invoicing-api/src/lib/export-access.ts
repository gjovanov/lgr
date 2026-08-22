/**
 * Permission gates for the invoicing/order export endpoints.
 *
 * Exporting only re-renders what the caller can already open on screen, so any invoicing READ
 * grant is enough — including the read-only `member` and `nra_auditor` roles (an NRA inspector
 * whose whole job is reading and exporting sales data must never be told "Forbidden").
 *
 * `trade.*` are the legacy pre-split grants. Both auth services expand them into the granular
 * permissions on every request, but they are accepted directly here so an unexpanded token
 * still works.
 */

type MaybeUser = { permissions?: string[]; role?: string } | null | undefined

export function canExport(user: MaybeUser): boolean {
  const perms: string[] = user?.permissions || []
  return perms.includes('invoicing.read') || perms.includes('invoicing.write')
    || perms.includes('trade.read') || perms.includes('trade.write')
    || user?.role === 'admin'
}

/** Mutating side-effects of a print (allocating a companion document number, storing a note). */
export function canWrite(user: MaybeUser): boolean {
  const perms: string[] = user?.permissions || []
  return perms.includes('invoicing.write') || perms.includes('trade.write') || user?.role === 'admin'
}
