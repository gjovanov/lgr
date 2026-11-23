import type { CapabilityId } from 'config/access'
import { useAccess } from 'ui-shared/access/useAccess'

/**
 * What mails a stock movement: the work on movements, or a Seller's transfers (FR-26.7). The server's own list
 * (`warehouse-api/lib/movement-email-guards.ts#MOVEMENT_EMAIL_WORK`, the rule both mail routes are reached by);
 * `unit/movement-email-guards.test.ts` holds the two together.
 */
export const MOVEMENT_EMAIL_CAPS: readonly CapabilityId[] = ['movements.create', 'movements.edit', 'movements.delete', 'movements.create:transfer']

/**
 * May this session e-mail the movements list's ticked movements (2026-11-16): the bar's „Изпрати по имейл" is
 * offered by the server's own rule, so nothing is offered that the request would answer 403.
 *
 * Presentation only: the two routes decide on their own, per movement. A Seller is offered the button, and a
 * receipt it ticked is said in the dialog not to go.
 */
export function mailsMovements(): boolean {
  return useAccess().can(MOVEMENT_EMAIL_CAPS)
}
