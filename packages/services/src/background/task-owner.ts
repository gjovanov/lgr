/**
 * Background tasks have an owner (FR-20.23, plan step P0a-6).
 *
 * A task runs inside the process that started it. When that process stops — a deploy, a crash,
 * an OOM kill — the task stays `processing` in Mongo forever (well, for the 7-day TTL), and the
 * screen polling it waits all that time. Failing every `processing` task at boot is not the
 * answer either: with several pods, the tasks of the pods still running would be failed too.
 *
 * So each task records its owner — this process, and the pod — and the owner refreshes a
 * heartbeat on every task it is still running. Any process fails only tasks whose owner has
 * gone quiet for longer than `STALE_MS`.
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { BackgroundTask } from 'db/models'
import { logger } from '../logger/logger.js'

/** This process, for the life of the process. A restarted pod is a new owner. */
export const PROCESS_ID = randomUUID()
export const POD = process.env.HOSTNAME || hostname()

export const HEARTBEAT_MS = 30_000
/** Four missed heartbeats. */
export const STALE_MS = 120_000
/** Tasks recorded before owners existed: stale once this old. */
const LEGACY_STALE_MS = 60 * 60_000

export function ownerNow() {
  return { process: PROCESS_ID, pod: POD, heartbeatAt: new Date() }
}

const OPEN = { $in: ['pending', 'processing'] }

/** Refresh the heartbeat of every open task this process owns. */
export async function heartbeatOwnedTasks(): Promise<number> {
  const r = await BackgroundTask.updateMany(
    { 'owner.process': PROCESS_ID, status: OPEN },
    { $set: { 'owner.heartbeatAt': new Date() } },
  ).exec()
  return r.modifiedCount
}

/** Fail the open tasks whose owner stopped. Returns how many. */
export async function failOrphanedTasks(now = new Date()): Promise<number> {
  const message = 'Interrupted: the server running this task stopped before it finished. Start it again.'
  const r = await BackgroundTask.updateMany(
    {
      status: OPEN,
      $or: [
        { 'owner.heartbeatAt': { $lt: new Date(now.getTime() - STALE_MS) } },
        { owner: { $exists: false }, startedAt: { $lt: new Date(now.getTime() - LEGACY_STALE_MS) } },
      ],
    },
    { $set: { status: 'failed', error: message, completedAt: now }, $push: { logs: `Job failed: ${message}` } },
  ).exec()
  if (r.modifiedCount) logger.warn({ count: r.modifiedCount }, 'Failed background tasks whose server stopped')
  return r.modifiedCount
}
