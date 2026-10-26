/**
 * Why the API refused a reservation operation, in the user's language (FR-22.37).
 *
 * `ReservationOpsError` answers with its English message plus a `code` and the figure it names
 * (`{ code: 'insufficient_stock', available: 3 }`). The dialogs show the translated sentence, with
 * that figure, where the user is looking: inside the dialog, not only in a snackbar. A refusal
 * without a code (a 404, a validation error) shows the API's message as before.
 *
 * `unit/reservation-errors.test.ts` holds this list to the codes the service sends.
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
] as const

export type ReservationErrorCode = (typeof RESERVATION_ERROR_CODES)[number]

type Translate = (key: string, params?: Record<string, unknown>) => string

export function reservationErrorMessage(e: any, t: Translate): string {
  const body = e?.response?.data
  const code = body?.code
  if (typeof code === 'string' && (RESERVATION_ERROR_CODES as readonly string[]).includes(code)) {
    return t(`invoicing.reservations.errors.${code}`, body)
  }
  return body?.message || t('common.operationFailed')
}

/** A refusal that a different source or a smaller quantity could get past (FR-22 §5.7). */
export function isShortage(e: any): boolean {
  const code = e?.response?.data?.code
  return code === 'insufficient_stock' || code === 'allocation_full' || code === 'line_demand_exceeded'
}
