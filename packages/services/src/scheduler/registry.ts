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
import { hostname } from 'node:os'
import { logger } from '../logger/logger.js'

/**
 * FR-29.27: where a job may run. `every-pod`: each process runs it (its work is the process's own, or it claims its
 * work in the database). `one`: one process at a time, under a lease (`SchedulerLease`), taken by a conditional write
 * as the migration lock is; another pod takes over when it lapses.
 */
export type SchedulerWhere = 'every-pod' | 'one'

export interface SchedulerDef {
  name: string
  /** 0 or less: disabled, as the `*_CHECK_INTERVAL_MS=0` settings already mean. */
  intervalMs: number
  tick: () => Promise<unknown>
  /** FR-29.27: every job says where it may run. */
  where: SchedulerWhere
  /** Run once at start (the catch-up pass most of them want after a restart). */
  immediate?: boolean
  /** Loaded lazily, so a module that fails to import fails only its own scheduler. */
  load?: () => Promise<void>
}

export interface SchedulerHealth {
  name: string
  state: 'disabled' | 'running' | 'failed_to_start'
  intervalMs: number
  where: SchedulerWhere
  /** FR-29.27: ticks not started because the previous one in this process was still running. */
  skippedOverlap: number
  /** FR-29.27: ticks not run because another process holds the job's lease (`one`). */
  skippedLease: number
  startedAt?: Date
  lastRunAt?: Date
  lastOkAt?: Date
  lastError?: string
  runs: number
  failures: number
}

const health = new Map<string, SchedulerHealth>()
const timers: ReturnType<typeof setInterval>[] = []
const running = new Set<string>()
/** The `one` jobs whose lease this process took at its last tick: what its graceful stop gives back. */
const leased = new Set<string>()

/** This process, as a lease names it. */
export const SCHEDULER_HOLDER = `${hostname()}#${process.pid}`

/** Takes or renews the lease of a `one` job for `ms`; false when another process holds it. Replaceable for tests. */
export type LeaseTaker = (name: string, holder: string, ms: number) => Promise<boolean>

/** The lease in the database: free, lapsed or already ours. A duplicate key is another process holding it. */
export const takeSchedulerLease: LeaseTaker = async (name, holder, ms) => {
  const { SchedulerLease } = await import('db/models')
  const now = new Date()
  try {
    const taken = await SchedulerLease.findOneAndUpdate(
      { _id: name, $or: [{ leaseUntil: { $lt: now } }, { holder }] },
      { $set: { holder, leaseUntil: new Date(now.getTime() + ms) }, $setOnInsert: { takenAt: now } },
      { upsert: true, new: true },
    ).lean().exec()
    return taken?.holder === holder
  } catch (e) {
    if ((e as { code?: unknown })?.code === 11000) return false
    throw e
  }
}

/** How long a `one` job's lease lasts: past its next tick, so the holder renews it before anybody else may take it. */
export function leaseMsOf(intervalMs: number): number {
  return Math.max(3 * intervalMs, 60_000)
}

let leaseTaker: LeaseTaker = takeSchedulerLease
/** Tests only: how `one` jobs take their lease. */
export function useLeaseTaker(taker: LeaseTaker, holder?: string): void {
  leaseTaker = taker
  if (holder) currentHolder = holder
}
let currentHolder = SCHEDULER_HOLDER

/** Gives back the leases `holder` holds of the jobs named; how many it gave back. Replaceable for tests. */
export type LeaseReleaser = (names: string[], holder: string) => Promise<number>

/** Lapses the leases in the database, so the next taker gets each at once. Only `holder`'s: never another process's. */
export const releaseLeasesInDb: LeaseReleaser = async (names, holder) => {
  const { SchedulerLease } = await import('db/models')
  const r = await SchedulerLease.updateMany({ _id: { $in: names }, holder }, { $set: { leaseUntil: new Date(0) } }).exec()
  return r.modifiedCount
}

let leaseReleaser: LeaseReleaser = releaseLeasesInDb
/** Tests only: how a graceful stop gives the leases back. */
export function useLeaseReleaser(releaser: LeaseReleaser): void {
  leaseReleaser = releaser
}

/**
 * The graceful stop (FR-20.23): gives back the leases of the `one` jobs this process holds and is not running now, so
 * the process that comes next takes each job at its first tick. Until 2026-11-23 a stop kept them, and the next
 * process skipped every tick until they lapsed (`leaseMsOf`: a minute for a 10 s job, three intervals for a longer
 * one), since a lease names its holder by pid. A master restarted a few seconds after a move's flip kept the org
 * frozen, refusing its writes, for that minute; its mail, identity changes and replication waited as long.
 *
 * Call it once the timers are halted, so no tick starts after it. A tick still running keeps its lease, which lapses
 * as before: another process must not run that job beside it. Never throws.
 *
 * ⚠ Accepted, not fixed (2026-11-23): a process that stops without this (a crash, a kill, a power cut) keeps its leases
 * until they lapse, `leaseMsOf` after its last renewal by the clock that wrote it, so a lease written while the clock
 * was ahead lapses that much later. The next process skips those jobs until then (`skippedLease` in
 * `schedulerHealth()`). There is no takeover: a process cannot tell a dead holder from a live one that is slow or whose
 * clock is wrong, and taking a lease that has not lapsed would run a `one` job twice. Sooner by hand: set the job's
 * `leaseUntil` in `scheduler_leases` to the past, once no other process of this database runs.
 */
export async function releaseSchedulerLeases(): Promise<string[]> {
  const names = [...leased].filter(n => !running.has(n))
  if (!names.length) return []
  try {
    await leaseReleaser(names, currentHolder)
    for (const n of names) leased.delete(n)
    return names
  } catch (e: any) {
    logger.warn({ schedulers: names, error: String(e?.message ?? e).slice(0, 300) }, 'Scheduler leases not given back: they lapse by themselves')
    return []
  }
}

export function schedulerHealth(): SchedulerHealth[] {
  return [...health.values()].map(h => ({ ...h }))
}

/**
 * One tick. FR-29.27: never while the previous one of this job is still running in this process (a tick slower than its
 * interval used to overlap itself), and for a `one` job only under its lease. Exported for the registry's tests.
 */
export async function runTick(def: SchedulerDef, h: SchedulerHealth): Promise<void> {
  if (running.has(def.name)) {
    h.skippedOverlap++
    logger.info({ scheduler: def.name }, 'Scheduler tick skipped: the previous one is still running')
    return
  }
  running.add(def.name)
  try {
    if (def.where === 'one') {
      let held: boolean
      try {
        held = await leaseTaker(def.name, currentHolder, leaseMsOf(def.intervalMs))
      } catch (e: any) {
        h.failures++
        h.lastError = `lease: ${String(e?.message ?? e).slice(0, 480)}`
        logger.warn({ scheduler: def.name, error: h.lastError }, 'Scheduler lease could not be read')
        return
      }
      if (!held) {
        leased.delete(def.name)
        h.skippedLease++
        return
      }
      leased.add(def.name)
    }
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
  } finally {
    running.delete(def.name)
  }
}

/** A job's health record before its first tick. */
export function newSchedulerHealth(def: Pick<SchedulerDef, 'name' | 'intervalMs' | 'where'>): SchedulerHealth {
  return { name: def.name, state: 'disabled', intervalMs: def.intervalMs, where: def.where ?? 'every-pod', runs: 0, failures: 0, skippedOverlap: 0, skippedLease: 0 }
}

/** Start each scheduler independently, in order. Never throws. */
export async function startSchedulers(defs: SchedulerDef[]): Promise<SchedulerHealth[]> {
  for (const def of defs) {
    const h = newSchedulerHealth(def)
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

/**
 * Stop every timer this module started, keeping the records: the graceful stop (FR-20.23), so no
 * backup or digest begins while the process is going down. A tick already running finishes.
 */
export function haltSchedulers(): void {
  for (const t of timers.splice(0)) clearInterval(t)
}

/** Tests only: stop every timer this module started and forget the records. */
export function stopSchedulers(): void {
  haltSchedulers()
  health.clear()
  running.clear()
  leased.clear()
  leaseTaker = takeSchedulerLease
  leaseReleaser = releaseLeasesInDb
  currentHolder = SCHEDULER_HOLDER
}
