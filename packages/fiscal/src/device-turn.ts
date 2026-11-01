import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One turn per fiscal device, in the process holding it.
 *
 * A driver serialises COMMANDS, and that is not enough. A receipt is many commands, and two receipts
 * on one device clear each other: the second one's open finds the first one's receipt open and voids
 * it, or the lines of both land under one УНП. Two sessions on one warehouse is normal, and FR-23 sends
 * every back-office issue and payment to the device the till prints on, so it is not a rare case.
 *
 * A turn runs from the read of the device's counter to the close of the receipt, the error path's
 * void included. Inside one, nothing else prints on the device, which is what makes the counter
 * evidence: read in a turn, a counter that moved by one moved for this document. Read outside a turn
 * it proves nothing (`payment-receipt.service.ts`, a dead receipt).
 *
 * Everything that prints a document takes a turn, because every document moves that counter: a sale, a
 * storno, a receipt, a Z or an X, a fiscal-memory report, a service receipt. A command that prints
 * nothing does not: a status read must still answer while a Z runs.
 *
 * ⚠ Re-entrant, through the async context: what runs inside a turn may call what also takes the turn.
 * A turn is never held while waiting for another device's, so turns cannot deadlock against each
 * other, and a slow holder only makes the next one wait.
 *
 * ⚠ In THIS process. With two pods a request runs on the pod holding the printer (FR-24.50), so that is
 * the one place a queue is needed, and the one place it can work.
 */

/**
 * How long a turn is waited for. Past the longest one command may take (5 minutes, a Z or a
 * fiscal-memory report, `eltrade.ts#TIMEOUT_MS`), so a sale behind a slow Z prints when the Z is done
 * and is not refused. It exists for a holder that never ends: a transport that hangs for good.
 */
export const TURN_WAIT_MS = 330_000

/** The device did not come free in time. Nothing was sent to it. */
export class DeviceBusyError extends Error {
  readonly code = 'device_busy'
  constructor(readonly deviceId: string) {
    super('The fiscal device is busy with another document. Nothing was printed; try again in a moment.')
    this.name = 'DeviceBusyError'
  }
}

/** The driver methods that print a document, each a turn of its own when not already in one. */
export const PRINTING_COMMANDS: ReadonlySet<string> = new Set([
  'printStornoReceipt',
  'printDailyZReport',
  'printDailyXReport',
  'printOperatorReport',
  'printFiscalMemoryReportByDate',
  'printFiscalMemoryReportByNumber',
  'printEJReport',
])

const tails = new Map<string, Promise<unknown>>()
const holding = new AsyncLocalStorage<ReadonlySet<string>>()

/** Whether this async context holds the device's turn. */
export function inDeviceTurn(deviceId: string): boolean {
  return !!holding.getStore()?.has(deviceId)
}

/** Run `run` in the device's turn: when every turn asked for before it has ended, and nothing else meanwhile. */
export async function deviceTurn<T>(deviceId: string, run: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  if (inDeviceTurn(deviceId)) return run()

  const ahead = tails.get(deviceId) ?? Promise.resolve()
  let finish!: () => void
  const mine = new Promise<void>(resolve => { finish = resolve })
  const tail = ahead.then(() => mine)
  tails.set(deviceId, tail)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const came = await Promise.race([
      ahead.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), opts.waitMs ?? TURN_WAIT_MS) }),
    ])
    if (!came) throw new DeviceBusyError(deviceId)
    return await holding.run(new Set([...(holding.getStore() ?? []), deviceId]), run)
  } finally {
    clearTimeout(timer)
    finish()
    if (tails.get(deviceId) === tail) tails.delete(deviceId)
  }
}
