/**
 * The process's schedulers, each on its own (FR-20.23, plan step P0a-6).
 *
 * They used to start one after another inside a single `try { … } catch { }` in `unified.ts`: a
 * throw in any of them — or in the data priming or the fiscal reset before them — silently left
 * every later scheduler unstarted. A failed NTP check at boot meant no backups, no digest and no
 * retention until the next restart, and nothing in the logs said so.
 *
 * Now each one starts in its own `try`, its ticks are caught one by one, and each keeps a health
 * record (`schedulerHealth()`) for the master's control socket (P1) and for diagnosis.
 */
import { logger } from '../logger/logger.js'

export interface SchedulerDef {
  name: string
  /** 0 or less: disabled, as the `*_CHECK_INTERVAL_MS=0` settings already mean. */
  intervalMs: number
  tick: () => Promise<unknown>
  /** Run once at start (the catch-up pass most of them want after a restart). */
  immediate?: boolean
  /** Loaded lazily, so a module that fails to import fails only its own scheduler. */
  load?: () => Promise<void>
}

export interface SchedulerHealth {
  name: string
  state: 'disabled' | 'running' | 'failed_to_start'
  intervalMs: number
  startedAt?: Date
  lastRunAt?: Date
  lastOkAt?: Date
  lastError?: string
  runs: number
  failures: number
}

const health = new Map<string, SchedulerHealth>()
const timers: ReturnType<typeof setInterval>[] = []

export function schedulerHealth(): SchedulerHealth[] {
  return [...health.values()].map(h => ({ ...h }))
}

async function runTick(def: SchedulerDef, h: SchedulerHealth): Promise<void> {
  h.lastRunAt = new Date()
  h.runs++
  try {
    await def.tick()
    h.lastOkAt = new Date()
    h.lastError = undefined
  } catch (e: any) {
    h.failures++
    h.lastError = String(e?.message ?? e).slice(0, 500)
    logger.warn({ scheduler: def.name, error: h.lastError }, 'Scheduler tick failed')
  }
}

/** Start each scheduler independently, in order. Never throws. */
export async function startSchedulers(defs: SchedulerDef[]): Promise<SchedulerHealth[]> {
  for (const def of defs) {
    const h: SchedulerHealth = { name: def.name, state: 'disabled', intervalMs: def.intervalMs, runs: 0, failures: 0 }
    health.set(def.name, h)
    if (!(def.intervalMs > 0)) continue
    try {
      if (def.load) await def.load()
      if (def.immediate) void runTick(def, h)
      timers.push(setInterval(() => { void runTick(def, h) }, def.intervalMs))
      h.state = 'running'
      h.startedAt = new Date()
      logger.info({ scheduler: def.name, intervalMs: def.intervalMs }, 'Scheduler started')
    } catch (e: any) {
      h.state = 'failed_to_start'
      h.lastError = String(e?.message ?? e).slice(0, 500)
      logger.error({ scheduler: def.name, error: h.lastError }, 'Scheduler failed to start — the others start regardless')
    }
  }
  return schedulerHealth()
}

/** Tests only: stop every timer this module started and forget the records. */
export function stopSchedulers(): void {
  for (const t of timers.splice(0)) clearInterval(t)
  health.clear()
}
