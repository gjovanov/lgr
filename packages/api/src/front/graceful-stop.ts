/**
 * FR-20.23 (plan step P1-3) — one graceful stop, whatever asked for it: SIGTERM or SIGINT
 * (Kubernetes, a console), or the supervisor over the control socket. A Windows service delivers
 * no signal to its child, and CTRL_BREAK ends a Bun process at once without running any handler
 * (measured: exit 0xC000013A), so on a master the socket is the only way this runs.
 *
 * 1. No new connections. Requests already being served go on, and so do the open WebSockets: a
 *    receipt printing through a fiscal bridge needs its socket to finish.
 * 2. The schedulers stop ticking, and give back the leases of their `one` jobs that are not mid-tick (FR-29.27): the
 *    next process takes each at its first tick.
 * 3. Wait, up to `LGR_STOP_WAIT_MS`, until no fiscal operation and no request is in flight. Then a master's capture
 *    stops and gives its lease back (FR-20.61), and so does a tick that was still running at step 2.
 * 4. Close the fiscal bridges with 1012, releasing their presence rows (FR-24.44): the tills
 *    reconnect at once, to a pod that takes connections. Then disconnect the fiscal devices, close the
 *    control socket and the database.
 * 5. Exit 0.
 *
 * ⚠ A second call while stopping returns the first one's promise: SIGTERM arriving during a
 * socket-requested stop must not start the sequence again.
 */
import { disconnectAll } from 'fiscal/fiscal-device.service'
import { fiscalInFlight } from 'fiscal/in-flight'
import { nodeRole } from 'config'
import { haltSchedulers, releaseSchedulerLeases } from 'services/scheduler/registry'
import { logger } from 'services/logger'

export interface StopDeps {
  /** The HTTP server, so it stops listening and its requests in flight can be counted. */
  server?: { stop: (closeActiveConnections?: boolean) => unknown; pendingRequests?: number } | null
  waitMs: number
  closeControl?: () => void
  /** FR-24.44: closes the fiscal bridges with 1012 once nothing fiscal is in flight. */
  closeBridges?: () => Promise<unknown>
  /** Closes the database. */
  disconnect?: () => Promise<unknown>
  /** `process.exit` unless a test says otherwise. */
  exit?: (code: number) => void
  /** Stops a master's replication capture and gives its lease back (FR-20.61). The engine's on a master by default. */
  stopCapture?: () => Promise<unknown>
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

/** Waits for `p`, at most `ms`: a step that must not hold the stop up. `p` must not reject. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p, new Promise(r => { timer = setTimeout(r, ms) })])
  clearTimeout(timer)
}

/** A master's capture: its tailer stopped and its lease given back. Nothing off a master. */
async function stopMasterCapture(): Promise<void> {
  if (nodeRole() !== 'master') return
  await (await import('services/biz/replication/engine')).stopCapture()
}

/**
 * FR-29.27: the leases this process holds go back, never throwing. A lease names its holder's pid and ends by its
 * holder's clock: one a stop kept held the next process off until it lapsed, a minute for most jobs, and as long as
 * the clock had been wrong when a clock put back was followed by a restart (the outbox, the identity feed, the move
 * worker that unfreezes a moved org, all waiting).
 */
const giveLeasesBack = () => within(releaseSchedulerLeases(), 2000)

async function run(reason: string, deps: StopDeps): Promise<void> {
  const started = Date.now()
  logger.info({ reason }, 'Stopping gracefully')
  try {
    void deps.server?.stop(false)
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'Stopping the HTTP listener failed')
  }
  haltSchedulers()
  await giveLeasesBack()

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
  // Writes made while it stops are not lost: the next process tails from the point the capture saved.
  await within(Promise.resolve().then(deps.stopCapture ?? stopMasterCapture).catch((e: any) => {
    logger.warn({ error: e?.message }, 'Stopping the replication capture failed: its lease lapses by itself')
  }), 2000)
  await giveLeasesBack()

  try {
    await deps.closeBridges?.()
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'Closing the fiscal bridges failed')
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
