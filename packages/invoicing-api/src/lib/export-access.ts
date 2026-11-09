/**
 * Permission gates for the invoicing/order export endpoints.
 *
 * Exporting only re-renders what the caller can already open on screen, so any invoicing READ
 * grant is enough — including the read-only `member` and `nra_auditor` roles (an NRA inspector
 * whose whole job is reading and exporting sales data must never be told "Forbidden").
 *
 * FR-27 (#529): the capabilities `sales-docs.export` and `sales-docs.edit` (`config/access`).
 */
import { can, type AccessCaller } from 'services/biz/access/evaluate'

type MaybeUser = AccessCaller | null | undefined

export function canExport(user: MaybeUser): boolean {
  return can(user, 'sales-docs.export')
}

/** Mutating side-effects of a print (allocating a companion document number, storing a note). */
export function canWrite(user: MaybeUser): boolean {
  return can(user, 'sales-docs.edit')
}
