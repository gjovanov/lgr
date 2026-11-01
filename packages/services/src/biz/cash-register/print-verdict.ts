/**
 * What a fiscal print that threw left behind. Import-pure: `register.service.ts` reads the device, and
 * the rule lives here where it can be held to the table.
 *
 * ⚠ Only ever in the document's turn on the device (`fiscal/device-turn`). In a turn nothing else has
 * printed since the counter was read, so a counter that moved by one moved for this document. Out of
 * one the same reading proves nothing, and a dead receipt is decided another way
 * (`payment-receipt.service.ts`).
 *
 * - **printed**: the receipt got as far as its money and the counter moved by one. The close went
 *   through and only its answer was lost, or abandoning the receipt finished it.
 * - **failed**: proved to have left nothing. The print never got as far as money and no close went
 *   through, or the counter did not move and the device has no receipt open.
 * - **unknown**: anything else. The money may be on the device or on paper, so it is never voided and
 *   never printed again: a second fiscal receipt for one payment is what print-once exists to prevent.
 *
 * ⚠ Before its money nothing can close this document, so there the counter says nothing about it,
 * whatever it reads. Clearing what an earlier document left open moves it, which is why the counter is
 * read after that (`printOnce`), and a device whose 71h numbers a voided receipt would move it on every
 * failure at a line. Whether one does is not known: the simulator's 3Ch does not, and neither the
 * protocol nor a physical device has said.
 */

/**
 * How far a receipt got. `paying` is from the moment the first payment command is SENT. `refused`: the
 * driver would not send it, so the device never saw it.
 */
export type PrintStage = 'refused' | 'opening' | 'lines' | 'paying' | 'closing'

export type PrintVerdict = 'printed' | 'failed' | 'unknown'

export interface FailedPrint {
  /** Unset for a driver that does not say how far it got. */
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
  const beforeTheMoney = p.stage === 'refused' || p.stage === 'opening' || p.stage === 'lines'
  const movedByOne = counted && p.now === p.before! + 1
  // The fallback close went through: a receipt is on the device, and only past the money is it all of this one.
  if (p.closed) return movedByOne && !beforeTheMoney ? 'printed' : 'unknown'
  if (beforeTheMoney) return 'failed'
  if (movedByOne) return 'printed'
  return counted && p.now === p.before && p.open === false ? 'failed' : 'unknown'
}
