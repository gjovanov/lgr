import { POSSession } from 'db/models'
import { logger } from '../../logger/logger.js'
import { createAuditEntry } from '../audit-log.service.js'
import type { RegisterPrinter } from './printer.js'

/**
 * #473 — a session's opening amount, on its fiscal device. Н-18 чл. 33 ал. 1: every change to a device's
 * cash outside a sale, the „начална сума" named first, is registered on it as „служебно въведени". Without
 * it the device reads short of the drawer by the float all day, and refuses a cash refund the drawer could
 * pay (чл. 31 ал. 3).
 *
 * The session owes it from the moment it opens (`deviceFloat`, only where a device can take it), and it
 * goes at the open, or first in the next turn on the device: a sale's, a storno's, a receipt's, the Z's.
 *
 * ⚠ Exactly once, over a line that loses answers, on a command with no key of its own. So the device's own
 * `ServIn` is the proof: read and recorded BEFORE the amount goes out. An attempt nobody heard the end of
 * stays owed, and the next turn reads whether `ServIn` rose by it. A Z in between zeroes `ServIn` and so
 * reads as not sent, which is right: that day's cash no longer holds it.
 *  - An attempt the device answered, or one it never got, keeps no record to prove: its `ServIn` did not
 *    move, and another session's slip would later read as this one's.
 *  - Another session's slip landing while this one's attempt waits for its proof is added to this one's
 *    record, since it moves the same `ServIn`.
 *
 * ⚠ Only ever in the device's turn. The read and the amount must have nothing between them, and the slip is
 * numbered like any document, so in a document's turn this comes before its counter read (`printOnce`), and
 * after what proves an interrupted print: read after this, the slip reads as that print.
 *
 * ⚠ A float never stops anything. It never throws, and it never marks a device in error: an unprinted slip
 * is a line on the session's report, and a device in error refuses every sale.
 *
 * What it does not settle: two attempts on one device that both lost their answers, where either one's slip
 * reads as the other's; an amount typed on the device's own keys in such a window; a session whose
 * documents move to a second device in its warehouse, which leaves the float on the first. A Z's effect on
 * another open session's float is #473's question for the accountant, like what a close takes out.
 */

/** What the float needs of a device. A `RegisterPrinter` is one, and so is a door's own turn. */
export type FloatPrinter = Pick<RegisterPrinter, 'deviceNumber' | 'readServiceCash' | 'moveServiceCash'>

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** The device said it did not run the command, or the driver never sent it. */
const neverRan = (e: any) => e?.kind === 'rejected' || e?.kind === 'input'

/** Still owed, and why. `forget`: nothing went out that a later read could prove. */
const noted = (sessionId: unknown, error: string, forget = false) => POSSession.updateOne(
  { _id: sessionId, 'deviceFloat.state': 'pending' },
  { $set: { 'deviceFloat.error': error.slice(0, 300) }, ...(forget ? { $unset: { 'deviceFloat.serviceInBefore': 1 } } : {}) },
).exec()

/** The device has it. */
async function settled(session: any, deviceNumber: string): Promise<void> {
  await POSSession.updateOne(
    { _id: session._id },
    {
      $set: { 'deviceFloat.state': 'registered', 'deviceFloat.deviceNumber': deviceNumber, 'deviceFloat.registeredAt': new Date() },
      $unset: { 'deviceFloat.serviceInBefore': 1, 'deviceFloat.error': 1 },
    },
  ).exec()
  createAuditEntry({
    orgId: String(session.orgId), userId: String(session.cashierId), action: 'service_cash_in', module: 'pos',
    entityType: 'pos_session', entityId: String(session._id), entityName: session.sessionNumber,
    changes: [{ field: 'openingBalance', oldValue: null, newValue: round2(session.openingBalance) }],
  })
}

/**
 * Register what `sessionId` still owes, in this turn on the device. Nothing owed, nothing sent.
 * `closing`: from the close itself, in the Z's turn. Otherwise only an open session's: a document that
 * outlives its session's claim prints after the Z, on the next day.
 */
export async function registerOpeningFloat(printer: FloatPrinter, sessionId: unknown, opts: { closing?: boolean } = {}): Promise<void> {
  if (!sessionId || !printer.readServiceCash || !printer.moveServiceCash) return
  let session: any
  try {
    session = await POSSession.findOne({ _id: sessionId, 'deviceFloat.state': 'pending', status: opts.closing ? 'closing_control' : 'open' }).lean().exec()
    if (!session) return

    const { deviceNumber } = printer
    const float = session.deviceFloat
    const amount = round2(session.openingBalance)
    const { serviceIn } = await printer.readServiceCash()
    const sentHere = float.deviceNumber === deviceNumber && typeof float.serviceInBefore === 'number'
    if (sentHere && serviceIn >= round2(float.serviceInBefore + amount)) {
      logger.info({ sessionId: String(session._id), deviceNumber, serviceIn }, 'Opening float: the attempt with no answer did reach the device')
      return await settled(session, deviceNumber)
    }

    await POSSession.updateOne({ _id: session._id }, { $set: { 'deviceFloat.deviceNumber': deviceNumber, 'deviceFloat.serviceInBefore': serviceIn } }).exec()
    let accepted: boolean
    try {
      ({ accepted } = await printer.moveServiceCash(amount))
    } catch (e: any) {
      if (!neverRan(e)) throw e
      logger.warn({ sessionId: String(session._id), deviceNumber, error: e?.message }, 'Opening float not taken by the device: it stays owed')
      return void await noted(session._id, String(e?.message || e), true)
    }
    if (!accepted) {
      logger.warn({ sessionId: String(session._id), deviceNumber, amount }, 'Opening float refused by the device: it stays owed')
      return void await noted(session._id, 'The device refused the opening amount, which it does while a receipt is open.', true)
    }
    await settled(session, deviceNumber)
    // Their `ServIn` was read before this slip, so this slip is not theirs.
    await POSSession.updateMany(
      { orgId: session.orgId, _id: { $ne: session._id }, 'deviceFloat.state': 'pending', 'deviceFloat.deviceNumber': deviceNumber, 'deviceFloat.serviceInBefore': { $type: 'number' } },
      { $inc: { 'deviceFloat.serviceInBefore': amount } },
    ).exec()
  } catch (e: any) {
    logger.warn({ sessionId: String(sessionId), error: e?.message }, 'Opening float did not finish: it stays owed')
    await noted(sessionId, String(e?.message || e)).catch(() => {})
  }
}
