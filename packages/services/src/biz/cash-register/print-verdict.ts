/**
 * What a fiscal print that threw left behind. Import-pure: `register.service.ts` reads the device, and
 * the rule lives here where it can be held to the table.
 *
 * ⚠ Only ever in the document's turn on the device (`fiscal/device-turn`). In a turn nothing else has
 * printed since the counter was read, so a counter that moved by one moved for this document. Out of
 * one the same reading proves nothing, and a dead receipt is decided another way
 * (`payment-receipt.service.ts`).
 *
 * - **printed**: the counter moved by one. The close went through and only its answer was lost, or
 *   abandoning the receipt finished it.
 * - **failed**: proved to have left nothing. The counter did not move and the device has no receipt
 *   open, or the print never got as far as money and no close went through.
 * - **unknown**: anything else. The money may be on the device or on paper, so it is never voided and
 *   never printed again: a second fiscal receipt for one payment is what print-once exists to prevent.
 */

/** How far a receipt got. `paying` is from the moment the first payment command is SENT. */
export type PrintStage = 'opening' | 'lines' | 'paying' | 'closing'

export type PrintVerdict = 'printed' | 'failed' | 'unknown'

export interface FailedPrint {
  /** Unset when the driver does the whole receipt in one call: a storno. */
  stage?: PrintStage
  /** The counter as read at the start of the turn. */
  before?: number | null
  /** The counter now, once the receipt was abandoned; undefined when the device cannot say. */
  now?: number
  /** Whether a receipt is open on the device now; undefined when it cannot say. */
  open?: boolean
  /** A driver with no cancel fell back on closing the receipt, and the close went through. */
  closed?: boolean
}

export function verdictOfFailedPrint(p: FailedPrint): PrintVerdict {
  const counted = p.before !== undefined && p.before !== null && p.now !== undefined
  if (counted && p.now === p.before! + 1) return 'printed'
  if (counted && p.now !== p.before) return 'unknown'
  // A receipt closed, and a device with no counter cannot say whose or for how much.
  if (p.closed) return 'unknown'
  if (counted && p.open === false) return 'failed'
  // The device proves nothing: what is known is how far the receipt got.
  return p.stage === 'opening' || p.stage === 'lines' ? 'failed' : 'unknown'
}
