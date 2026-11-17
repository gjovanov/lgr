import { can, type AccessCaller } from './evaluate'

/**
 * FR-27.6 (#529) — may this session learn of a partition's documents where it reads ANOTHER feature: a receipt's bill,
 * a contact's purchases, the payables side of the aging report, an order or a reservation on a product's stock tab.
 * The partition's own capabilities decide: a role without bills learns of none. (FR-26's areas decided for a legacy
 * session until FR-27 P3-6.)
 */
type Caller = AccessCaller | null | undefined

export function seesBills(user: Caller): boolean {
  return can(user, 'bills.view')
}

export function seesOrders(user: Caller): boolean {
  return can(user, ['orders.view', 'orders.browse', 'orders.lookup'])
}
