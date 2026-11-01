import { routeKey } from '../route-class.js'

/**
 * FR-20.55 — what an expired licence stops, on a master: **a new sale, at the till or as a document.**
 * Every route here, and nothing else.
 *
 * ⚠ Deliberately a short list of things to stop, never a list of things to allow. What expiry must
 * never block is everything else, and most of it is named in the requirement: reading, exports, the
 * SUPTO export, backups, the fiscal day close, a storno or credit note of an existing sale, a payment
 * against an existing document, and a move back to the cloud. Also left alone:
 * - **a session that was already open** keeps selling: the restriction starts at a local midnight
 *   (`licence-state.ts`) so as never to land in the middle of one;
 * - **opening a session.** ⚠ Where LGR prints, a payment on a document needs one: its receipt prints on
 *   that session's device (FR-23), so refusing the session refused the payment this list promises.
 *   A session opened under an expired licence takes that money and closes its day, and it rings up
 *   nothing new: `/transaction` is here, for a session opened since the restriction began;
 * - **an existing draft** can still be issued (`/send`), its receipt with it: it was started before;
 * - **bills, stock receipts, imports and master data**: the books a customer leaves with must stay
 *   complete;
 * - **debit notes**, which correct an existing sale as a credit note does. ⚠ One written since prints
 *   no receipt (`counter-receipt.ts`): its lines are whatever it was given, so that receipt would be a
 *   new sale on the device.
 *
 * `licence-gate.flow.test.ts` holds every key here to a real route, so a renamed route fails a test
 * instead of quietly falling out of the gate.
 *
 * Import-pure.
 */

export interface LicensedAction {
  /** What is stopped, in the words the refusal uses. */
  what: string
  /**
   * When only some bodies of the route start something new. ⚠ Such a route is decided by its
   * HANDLER, which calls `licenceGate` with its body: the auth plugins never read a body, because
   * naming one in a shared hook makes Elysia parse every route's body (the Stripe webhook's raw body
   * among them).
   */
  when?: (body: any) => boolean
}

const NEW_SALES_DOCUMENT_TYPES = new Set(['invoice', 'proforma', 'cash_sale'])

export const LICENSED_ACTIONS: ReadonlyMap<string, LicensedAction> = new Map<string, LicensedAction>([
  // Decided by the handler: it has the session, and one opened before the restriction keeps selling.
  ['POST /api/org/:orgId/trade/pos/session/:id/transaction', { what: 'a new till sale', when: body => body?.type === 'sale' }],
  ['POST /api/org/:orgId/invoices', {
    what: 'a new invoice, proforma or cash sale',
    when: body => body?.direction === 'outgoing' && NEW_SALES_DOCUMENT_TYPES.has(body?.type),
  }],
  ['POST /api/org/:orgId/invoices/:id/convert', { what: 'invoicing a proforma' }],
  ['POST /api/org/:orgId/invoices/:id/to-invoice', { what: 'invoicing a cash sale' }],
  ['POST /api/org/:orgId/invoices/:id/attach-to-cash-sale', { what: 'attaching an invoice to a cash sale' }],
  ['POST /api/org/:orgId/invoicing/internal-orders', { what: 'a new client order' }],
  ['POST /api/org/:orgId/invoicing/internal-orders/:id/convert', { what: 'invoicing a client order' }],
  ['POST /api/org/:orgId/invoicing/orders/:id/convert', { what: 'invoicing reserved stock' }],
])

/**
 * The action this request starts, when it is one an expired licence stops; null otherwise. With no
 * body (the auth plugins), a route that decides on its body is left to its handler.
 */
export function licensedAction(method: string, route: string, body?: unknown): LicensedAction | null {
  // A route declared as `/` under its prefix keeps the slash (`POST …/internal-orders/`).
  const action = LICENSED_ACTIONS.get(routeKey(method, route).replace(/\/+$/, ''))
  if (!action) return null
  if (!action.when) return action
  return body !== undefined && action.when(body) ? action : null
}
