import type { RegisterPrinter } from './printer.js'

/**
 * How a document prints (owner, 2026-11-01, and for a till sale since the prod sweep's D1): the device
 * decides, never a switch.
 *
 * A device that is not fiscalized refuses a fiscal receipt, so a cash invoice on it would be issued,
 * unpaid, with an error, however it was paid. A device that reports `fiscalized === false` in its own
 * status prints text. `undefined` or `true` is fiscal: a device that does not report it (a Tremol or a
 * Datecs today) never gets text, and a fiscalized device can never print it.
 *
 * ⚠ No request field, org setting or screen selects this. The till had a switch, and in a fresh browser it
 * made a fiscal device print a slip the Z never saw, with the money booked. An old tab still sends
 * `nonFiscal`: the route takes it and reads nothing of it.
 *
 * ⚠ Read fresh, in the document's turn on the device, and never kept: a unit fiscalized by service while
 * it stays connected goes fiscal on its next receipt. A status that cannot be read throws. It is never
 * "not fiscalized", or a device that stopped answering would print a fiscalized shop's sale as text.
 *
 * A receipt, a refund's storno and a till sale decide with this, each in its turn. A till sale's storno
 * prints what its sale printed, so it asks nothing here.
 */
export type ReceiptMode = 'fiscal' | 'text'

export async function receiptMode(printer: Pick<RegisterPrinter, 'fiscalized'>): Promise<ReceiptMode> {
  return (await printer.fiscalized()) === false ? 'text' : 'fiscal'
}
