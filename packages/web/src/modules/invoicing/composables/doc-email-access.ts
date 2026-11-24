import { writesKind, type DocKind } from 'config/access'
import { useAccess } from 'ui-shared/access/useAccess'

/**
 * May this session e-mail a list's ticked documents (2026-11-16): the bar's „Изпрати по имейл" is offered by the
 * server's own rules (`api/src/invoicing/lib/email-guards`), so nothing is offered that the request would answer 403.
 *
 * Presentation only: the two routes decide on their own, per document.
 */
export function useDocEmailAccess() {
  const access = useAccess()
  return {
    /** A list of the invoice collection, by the kind it shows: the work on that kind (`invoiceEmailSkip`). */
    invoices: (kind: DocKind): boolean => writesKind(access.grant(), kind, 'edit'),
    /** The supplier orders: what a sheet's export takes, and the work on orders (`mayEmailOrders`). */
    orders: (): boolean =>
      access.can(['orders.view', 'orders.browse', 'orders.lookup']) && access.can('sales-docs.export') && access.can(['orders.create', 'orders.edit']),
    /**
     * The customer orders (`mayEmailInternalOrders`): as the supplier orders', but read by `orders.view` alone, which
     * is all that reaches a customer order's sheet. `unit/doc-email-access` holds this to the server's rule.
     */
    internalOrders: (): boolean =>
      access.can('orders.view') && access.can('sales-docs.export') && access.can(['orders.create', 'orders.edit']),
  }
}
