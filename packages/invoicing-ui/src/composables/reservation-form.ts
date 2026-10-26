/**
 * The rules the reservation dialogs share (FR-22.37), kept free of Vue so they are unit-tested:
 * what releasing part of a reservation leaves.
 */

export interface ReleaseOutcome {
  /** quantity − max(invoiced, dispatched): what a release may free. */
  releasable: number
  /** What is already invoiced or dispatched: it stays reserved whatever is released. */
  consumed: number
  /** Releasing `amount` cancels the reservation (everything, and nothing consumed). */
  cancels: boolean
  /** What stays reserved afterwards. */
  remaining: number
  /** `amount` is more than nothing and no more than is releasable. */
  valid: boolean
}

/** What releasing `amount` of a reservation does — the server's `applyReservationCancel` rule. */
export function releaseOutcome(
  r: { quantity?: number; invoicedQuantity?: number; dispatchedQuantity?: number },
  amount: number,
): ReleaseOutcome {
  const quantity = Number(r.quantity) || 0
  const consumed = Math.max(Number(r.invoicedQuantity) || 0, Number(r.dispatchedQuantity) || 0)
  const releasable = Math.max(0, quantity - consumed)
  const a = Number(amount) || 0
  const valid = a > 0 && a <= releasable + 1e-9
  const all = a >= releasable - 1e-9
  const cancels = valid && all && consumed <= 0
  return { releasable, consumed, cancels, remaining: valid ? (cancels ? 0 : Math.max(consumed, quantity - a)) : quantity, valid }
}
