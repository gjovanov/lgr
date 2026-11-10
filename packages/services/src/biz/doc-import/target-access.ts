import { can } from '../access/evaluate'
import type { ImportTarget } from './types.js'

/**
 * What a session needs to put a document into a target: one rule, asked by the import dialog
 * (`doc-import.controller`) and by the Files app (`files/doc-access`), so what a document may book
 * does not depend on which door it came in by.
 */

/** Uploading and analysing is a write on the surface being imported into. */
export const PERMISSION_BY_TARGET: Record<ImportTarget, string> = {
  sales_invoice: 'invoicing.write',
  bill: 'invoicing.write',
  cash_sale: 'invoicing.write',
  movement: 'inventory.write',
}

/** What the rule reads of a session: the claims of its token. */
export interface ImportActor {
  role?: string
  permissions?: readonly string[]
  areas?: readonly string[] | null
  /** FR-27.5: an org on `roles`, the role's grant. */
  access?: any
}

/** Why this session may not import into `target`, or null. FR-27.6 (FR-26.6): a bill also needs bills. */
export function targetRefusal(user: ImportActor, target: ImportTarget) {
  const permission = PERMISSION_BY_TARGET[target]
  if (permission && !user.permissions?.includes(permission)) return { message: `Permission required: ${permission}` }
  if (target === 'bill' && !can(user as any, 'bills.create')) {
    return { code: 'area_required', area: 'purchases', message: 'Incoming documents are not part of your role.' }
  }
  return null
}
