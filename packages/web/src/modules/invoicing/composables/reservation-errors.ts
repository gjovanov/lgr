/**
 * Why the API refused a reservation or order operation, in the user's language (FR-22.37).
 *
 * `ReservationOpsError` answers with its English message plus a `code` and the figure it names
 * (`{ code: 'insufficient_stock', available: 3 }`); the client-order and supplier-order endpoints
 * pass both through. The dialogs show the translated sentence, with that figure, where the user is
 * looking: inside the dialog, not only in a snackbar. A refusal without a code (a 404, a validation
 * error) shows the API's message as before.
 *
 * `unit/reservation-screen.test.ts` holds RESERVATION_ERROR_CODES to the codes the service sends,
 * and ORDER_ERROR_CODES to the supplier-order controller's own.
 */
export const RESERVATION_ERROR_CODES = [
  'insufficient_stock',
  'allocation_full',
  'line_demand_exceeded',
  'contact_mismatch',
  'order_not_reservable',
  'incoming_order_not_reservable',
  'releasable_exceeded',
  'nothing_to_release',
  'already_cancelled',
  'below_consumed',
  'reservation_not_active',
  'nothing_to_preempt',
  'incoming_order_not_completable',
  'incoming_order_not_cancellable',
  'incoming_order_has_invoices',
  'order_not_draft',
  'no_target_warehouse',
] as const

/** Codes the supplier-order controller sends itself (`order.controller.ts`). */
export const ORDER_ERROR_CODES = ['order_has_invoices'] as const

export type ReservationErrorCode = (typeof RESERVATION_ERROR_CODES)[number] | (typeof ORDER_ERROR_CODES)[number]

const KNOWN: readonly string[] = [...RESERVATION_ERROR_CODES, ...ORDER_ERROR_CODES]

type Translate = (key: string, params?: Record<string, unknown>) => string

export function reservationErrorMessage(e: any, t: Translate): string {
  const body = e?.response?.data
  const code = body?.code
  if (typeof code === 'string' && KNOWN.includes(code)) {
    return t(`invoicing.reservations.errors.${code}`, body)
  }
  return body?.message || t('common.operationFailed')
}

/** A refusal that a different source or a smaller quantity could get past (FR-22 §5.7). */
export function isShortage(e: any): boolean {
  const code = e?.response?.data?.code
  return code === 'insufficient_stock' || code === 'allocation_full' || code === 'line_demand_exceeded'
}
