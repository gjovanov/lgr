/**
 * The capture's scheduler (FR-20.61, plan steps P3-1b, P3-2b): on a master linked at Full, keep one
 * tailer running (`capture.ts`) under the lease, capture every org homed here, and report its health
 * with the other schedulers (`schedulerHealth()`, the control socket's status).
 *
 * Every 5 s: if this process tails, it renews nothing here (the tailer renews its own lease) and only
 * enables orgs newly homed here; if it does not, it tries the lease, and on it starts the stream FROM
 * a saved point before it seeds anything (`establishToken`).
 *
 * ⚠ It follows the link, read from the supervisor's registration (`LGR_REGISTRATION_FILE`) every few
 * seconds: on at Full, off at Control or unregistered, since a master linked at Control sends no
 * business data anywhere (FR-20.54) and journaling every write there would cost a write for nothing.
 * Going down from Full stops the stream; the journal stays, so going back up continues it.
 * `LGR_REPLICATION=on|off` overrides the link either way.
 */
import { readFileSync } from 'node:fs'
import { config, nodeRole } from 'config'
import { logger } from '../../logger/logger.js'
import { enableOrgs, ensureCapturable, establishToken, holderId, LeaseLostError, releaseLease, tail, takeLease } from './capture.js'

const me = holderId()
let running: Promise<void> | null = null
let abort: AbortController | null = null

const LINK_CACHE_MS = 5_000
let link: { at: number; full: boolean } | null = null

/** Whether the supervisor's registration names a Full link, read again every few seconds. */
export function linkedFull(now = Date.now()): boolean {
  if (link && now - link.at < LINK_CACHE_MS) return link.full
  let full = false
  try {
    const file = config.replication.registrationFile
    full = !!file && JSON.parse(readFileSync(file, 'utf8'))?.linkLevel === 'full'
  } catch {
    // Unregistered (no file), or one half written: not Full, until it reads.
  }
  link = { at: now, full }
  return full
}

/** Tests, and a registration that just changed. */
export function forgetLink(): void {
  link = null
}

/** Whether this process captures at all. */
export function captureOn(): boolean {
  if (nodeRole() !== 'master') return false
  return config.replication.capture ?? linkedFull()
}

async function handles() {
  const { mongoose } = await import('db/connection')
  const db = mongoose.connection.db
  if (!db) throw new Error('the database is not connected')
  return { db, client: mongoose.connection.getClient() as any }
}

async function homeOrgIds(): Promise<unknown[]> {
  const { Org } = await import('db/models')
  const { homeScope } = await import('db/home/home')
  return Org.distinct('_id', await homeScope('_id')).exec()
}

/** One tick: the tailer kept running, and the orgs homed here captured. Never throws for a held lease. */
export async function captureTick(): Promise<{ tailing: boolean; enabled: number }> {
  if (!captureOn()) {
    // The link went down from Full: the stream stops, and the journal stays for when it comes back.
    if (running) {
      await stopCapture()
      logger.info('Replication: the link is not Full; the capture stopped')
    }
    return { tailing: false, enabled: 0 }
  }
  const { db, client } = await handles()
  if (!running) {
    if (!(await takeLease(db, me))) return { tailing: false, enabled: 0 }
    await ensureCapturable(db)
    const engine = await db.collection<any>('repl_engine').findOne({ _id: 'engine' })
    if (!engine?.resumeToken) await establishToken(db, me)
    abort = new AbortController()
    running = tail({ client, db, me, signal: abort.signal })
      .catch(e => {
        if (e instanceof LeaseLostError) logger.warn('Replication: the capture lease was lost; another process tails now')
        else logger.error({ err: e?.message ?? String(e) }, 'Replication: the capture stopped; it restarts at the next tick')
      })
      .finally(() => {
        running = null
        abort = null
      })
  }
  // Seeded after the stream's starting point is saved: a write during the seed is in the stream.
  const fresh = await enableOrgs(db, await homeOrgIds())
  return { tailing: true, enabled: fresh.length }
}

/** Stop tailing and give the lease back (a graceful stop, a link going down, tests). */
export async function stopCapture(): Promise<void> {
  const held = !!running
  abort?.abort()
  await running
  if (held) {
    const { db } = await handles()
    await releaseLease(db, me).catch(() => {})
  }
}
