/**
 * What proves a fiscal print, all of it. Import-pure: `register.service.ts` and
 * `payment-receipt.service.ts` read the device, and the rules live here where they can be held to the
 * table.
 *
 * ⚠ `verdictOfFailedPrint` only ever in the document's turn on the device (`fiscal/device-turn`). In a
 * turn nothing else has printed since the counter was read, so a counter that moved by one moved for
 * this document. Out of one a counter proves nothing, for any document: the device is shared, and
 * what moved it may be anybody's. There `provedNotPrinted` is all that can be asked.
 *
 * - **printed**: the receipt got as far as its money and the counter moved by one. The close went
 *   through and only its answer was lost, or abandoning the receipt finished it.
 * - **failed**: proved to have left nothing. The print never got as far as money and no close went
 *   through, or the counter did not move and the device has no receipt open.
 * - **unknown**: anything else. The money may be on the device or on paper, so it is never voided and
 *   never printed again: a second fiscal receipt for one payment is what print-once exists to prevent.
 *
 * ⚠ Before its money only the driver's own fallback can close this document (`AbandonOutcome`), so with
 * no such word the counter says nothing about it there, whatever it reads. Clearing what an earlier
 * document left open moves it, which is why the counter is read after that (`printOnce`).
 *
 * ⚠ What the driver did to the receipt, when it knows, comes before any counter. Voided is `failed` at
 * every stage, so whether a real device's 71h numbers a voided receipt, which neither the protocol nor
 * a physical device has said, no longer matters where the driver saw it happen.
 */

/**
 * How far a receipt got. `paying` is from the moment the first payment command is SENT. `refused`: the
 * driver would not send it, so the device never saw it.
 */
export type PrintStage = 'refused' | 'opening' | 'lines' | 'paying' | 'closing'

export type PrintVerdict = 'printed' | 'failed' | 'unknown'

/**
 * What abandoning a half-printed receipt did, as the driver saw it. No word at all is the third
 * answer, and the counter decides as if it had said nothing.
 *
 * - **voided**: the driver SAW a receipt open, cancelled it, and the device says it is gone. Nothing of
 *   this document is on the device.
 * - **finished**: the cancel was refused, so it closed the receipt with the rest in cash, or it tried to
 *   and lost the answer. A receipt may be on the device, whose lines and tenders may not be this
 *   document's, at any stage.
 *
 * ⚠ It may say voided only if it saw a receipt open BEFORE it cancelled. After a close whose answer was
 * lost nothing is open, the cancel does nothing and the status reads not open: read as voided, a real
 * receipt would book as failed and print again. An open flag it could not read is no sight of one.
 */
export type AbandonOutcome = 'voided' | 'finished'

export interface FailedPrint {
  /** Unset for a driver that does not say how far it got. */
  stage?: PrintStage
  /** The counter as read at the start of the turn. */
  before?: number | null
  /** The counter now, once the receipt was abandoned; undefined when the device cannot say. */
  now?: number
  /** Whether a receipt is open on the device now; undefined when it cannot say. */
  open?: boolean
  /** What abandoning the receipt did, when the driver knows. */
  abandoned?: AbandonOutcome
}

/**
 * A print that stopped in an earlier turn, read in this one: a request that died, whichever document
 * it was. Nothing closed since it started and nothing is open, so it never printed, and only then.
 * Anything else may be its print or anybody else's, a counter moved by exactly one included: the
 * document is then `unknown`, or held for a person, and never printed again.
 */
export function provedNotPrinted(p: Pick<FailedPrint, 'before' | 'now' | 'open'>): boolean {
  return p.before !== undefined && p.before !== null && p.now === p.before && p.open === false
}

export function verdictOfFailedPrint(p: FailedPrint): PrintVerdict {
  if (p.abandoned === 'voided') return 'failed'
  const counted = p.before !== undefined && p.before !== null && p.now !== undefined
  const beforeTheMoney = p.stage === 'refused' || p.stage === 'opening' || p.stage === 'lines'
  const movedByOne = counted && p.now === p.before! + 1
  // Its fallback finished it: a receipt is on the device, and only past the money is it all of this one.
  if (p.abandoned === 'finished') return movedByOne && !beforeTheMoney ? 'printed' : 'unknown'
  if (beforeTheMoney) return 'failed'
  if (movedByOne) return 'printed'
  return provedNotPrinted(p) ? 'failed' : 'unknown'
}
