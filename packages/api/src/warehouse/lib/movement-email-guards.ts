/**
 * Who e-mails which stock movement (2026-11-16): the rules of `POST warehouse/movement/email` and of its preview,
 * as pure functions.
 *
 * One movement is one ROW of the answer, never the request's status: a draft among five ticked movements is skipped
 * and the other four go. So `movementEmailSkip` answers a reason (`config/doc-email#DocEmailSkip`) or null, and the
 * SAME function decides the preview and the mail request, which therefore cannot disagree. `just_sent` is the one
 * reason only the request can give: it needs the address.
 *
 * Import-pure (no `db/models`): the unit test asks every rule without a database.
 */

import { can, type CapabilityId, type Grant } from 'config/access'
import type { DocEmailSkip } from 'config/doc-email'
import { writesTransfersOnly } from './movement-access.js'

/**
 * What reads a movement: the rule `GET warehouse/movement/:id` and its `/export` are reached by, and they ask
 * nothing more of a movement of the org (`config/access/routes.ts#READ_PREFIXES`; the unit test holds the two
 * together).
 */
export const MOVEMENT_READS: readonly CapabilityId[] = ['movements.view', 'movements.lookup', 'sales-docs.view']

/**
 * What mails a movement: the work on movements, or a Seller's transfers (FR-26.7). The rule every write under
 * `warehouse/movement` is reached by, these two routes among them (`routes.ts#WRITE_PREFIXES`), so a session without
 * it has its 403 from the auth plugin before the body is read.
 */
export const MOVEMENT_EMAIL_WORK: readonly CapabilityId[] = ['movements.create', 'movements.edit', 'movements.delete', 'movements.create:transfer']

/** May this session e-mail ANY movement: the request's 403, and what shows the list's button. */
export function mayEmailMovements(grant: Grant | null | undefined): boolean {
  return can(grant, MOVEMENT_EMAIL_WORK)
}

type EmailableMovement = { type?: string | null; status?: string | null } | null | undefined

/**
 * Why ONE movement does not go, or null when it does.
 *
 * Order, asserted by the tests: not in this org, or a session that reads no movements (one answer for both, so a
 * role learns nothing about what it does not read) → a movement the session reads and does not work on: any type but
 * a transfer for a transfer-only session (FR-26.7, `movement-access.ts`, the rule its writes go by) → a draft, which
 * is not booked and may still change → a cancelled one, which moved nothing → the double-click window.
 */
export function movementEmailSkip(input: {
  grant: Grant | null | undefined
  /** `null` when the id names no movement of this org. */
  movement: EmailableMovement
  recentSend?: boolean
}): DocEmailSkip | null {
  if (!input.movement) return 'not_found'
  if (!can(input.grant, MOVEMENT_READS)) return 'not_found'
  // Mailing a sheet to the other site is an outward act on the org's behalf, not a read: it takes the work.
  if (!mayEmailMovements(input.grant)) return 'forbidden'
  if (writesTransfersOnly(input.grant) && input.movement.type !== 'transfer') return 'forbidden'
  if (input.movement.status === 'draft') return 'draft'
  if (input.movement.status === 'cancelled') return 'cancelled'
  if (input.recentSend) return 'just_sent'
  return null
}
