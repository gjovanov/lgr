import type { RegisterPrinter } from './printer.js'

/**
 * How a receipt on an invoice prints (owner, 2026-11-01): the device decides, never a switch.
 *
 * A device that is not fiscalized refuses a fiscal receipt, so a cash invoice on it would be issued,
 * unpaid, with an error, however it was paid. A device that reports `fiscalized === false` in its own
 * status prints text. `undefined` or `true` is fiscal: a device that does not report it (a Tremol today)
 * never gets text, and a fiscalized device can never print it.
 *
 * ⚠ No request field, org setting or screen selects this. The till's „Нефискален" switch is the till's,
 * for a sale someone chose to ring up that way, and it has no say here.
 *
 * ⚠ Read fresh, in the document's turn on the device, and never kept: a unit fiscalized by service while
 * it stays connected goes fiscal on its next receipt. A status that cannot be read throws. It is never
 * "not fiscalized", or a device that stopped answering would print a fiscalized shop's sale as text.
 *
 * R2's `payment_storno` decides with this too.
 */
export type ReceiptMode = 'fiscal' | 'text'

export async function receiptMode(printer: Pick<RegisterPrinter, 'fiscalized'>): Promise<ReceiptMode> {
  return (await printer.fiscalized()) === false ? 'text' : 'fiscal'
}
