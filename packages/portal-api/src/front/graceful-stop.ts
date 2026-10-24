/**
 * FR-20.23 (plan step P1-3) — one graceful stop, whatever asked for it: SIGTERM or SIGINT
 * (Kubernetes, a console), or the supervisor over the control socket. A Windows service delivers
 * no signal to its child, and CTRL_BREAK ends a Bun process at once without running any handler
 * (measured: exit 0xC000013A), so on a master the socket is the only way this runs.
 *
 * 1. No new connections. Requests already being served go on, and so do the open WebSockets: a
 *    receipt printing through a fiscal bridge needs its socket to finish.
 * 2. The schedulers stop ticking.
 * 3. Wait, up to `LGR_STOP_WAIT_MS`, until no fiscal operation and no request is in flight.
 * 4. Disconnect the fiscal devices, then close the control socket and the database.
 * 5. Exit 0.
 *
 * ⚠ A second call while stopping returns the first one's promise: SIGTERM arriving during a
 * socket-requested stop must not start the sequence again.
 */
import { disconnectAll } from 'fiscal/fiscal-device.service'
import { fiscalInFlight } from 'fiscal/in-flight'
import { haltSchedulers } from 'services/scheduler/registry'
import { logger } from 'services/logger'

export interface StopDeps {
  /** The HTTP server, so it stops listening and its requests in flight can be counted. */
  server?: { stop: (closeActiveConnections?: boolean) => unknown; pendingRequests?: number } | null
  waitMs: number
  closeControl?: () => void
  /** Closes the database. */
  disconnect?: () => Promise<unknown>
  /** `process.exit` unless a test says otherwise. */
  exit?: (code: number) => void
}

let stopping: Promise<void> | undefined

export function isStopping(): boolean {
  return stopping !== undefined
}

export function gracefulStop(reason: string, deps: StopDeps): Promise<void> {
  stopping ??= run(reason, deps)
  return stopping
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function run(reason: string, deps: StopDeps): Promise<void> {
  const started = Date.now()
  logger.info({ reason }, 'Stopping gracefully')
  try {
    void deps.server?.stop(false)
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'Stopping the HTTP listener failed')
  }
  haltSchedulers()

  const busy = () => ({ fiscal: fiscalInFlight(), requests: Math.max(0, deps.server?.pendingRequests ?? 0) })
  const deadline = started + deps.waitMs
  let left = busy()
  while ((left.fiscal > 0 || left.requests > 0) && Date.now() < deadline) {
    await sleep(100)
    left = busy()
  }
  if (left.fiscal > 0 || left.requests > 0) {
    logger.warn({ ...left, waitedMs: Date.now() - started }, 'Stopping with work still in flight: the wait ran out')
  }

  try {
    await disconnectAll()
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'Disconnecting the fiscal devices failed')
  }
  try {
    deps.closeControl?.()
  } catch { /* the process is going anyway */ }
  try {
    if (deps.disconnect) await Promise.race([deps.disconnect(), sleep(2000)])
  } catch { /* the process is going anyway */ }
  logger.info({ reason, ms: Date.now() - started }, 'Stopped')
  ;(deps.exit ?? (code => process.exit(code)))(0)
}

/** Tests only: forget a stop that has run. */
export function resetGracefulStopForTests(): void {
  stopping = undefined
}
