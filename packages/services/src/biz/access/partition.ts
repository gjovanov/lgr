import { holdsArea } from 'config/constants'
import { can, type AccessCaller } from './evaluate'

/**
 * FR-27.6 (#529) — may this session learn of a partition's documents where it reads ANOTHER feature: a receipt's bill,
 * a contact's purchases, the payables side of the aging report, an order or a reservation on a product's stock tab.
 *
 * ⚠ Two models, two answers, each exactly its own:
 *   - legacy (the token's claims decide): FR-26's area, as before. An absent `areas` list holds every area, whatever the
 *     permissions: a warehouse manager, who holds no invoicing permission, sees the bill that holds a receipt.
 *     `bills.view` would not say so: legacy grants it only with an invoicing permission.
 *   - a role (an org on `roles`, `user.access`): the partition's own capabilities. A role without bills learns of none.
 *
 * Where only sessions holding the partition's app reach the check (the invoice controller's routes), the grant answers
 * as the area does (`unit/access-legacy-gates.test.ts`), and `config/access/partition.ts` is used directly.
 */
type Caller = (AccessCaller & { access?: unknown }) | null | undefined

export function seesBills(user: Caller): boolean {
  if (!user) return false
  return user.access ? can(user, 'bills.view') : holdsArea(user as any, 'purchases')
}

export function seesOrders(user: Caller): boolean {
  if (!user) return false
  return user.access ? can(user, ['orders.view', 'orders.browse', 'orders.lookup']) : holdsArea(user as any, 'orders')
}
