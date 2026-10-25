/**
 * The capture's scheduler (FR-20.61, plan step P3-1b): on a master with `LGR_REPLICATION=on`, keep
 * one tailer running (`capture.ts`) under the lease, capture every org homed here, and report its
 * health with the other schedulers (`schedulerHealth()`, the control socket's status).
 *
 * Every 5 s: if this process tails, it renews nothing here (the tailer renews its own lease) and only
 * enables orgs newly homed here; if it does not, it tries the lease, and on it starts the stream FROM
 * a saved point before it seeds anything (`establishToken`).
 *
 * ⚠ Off unless asked for: a master linked at Control sends no business data anywhere (FR-20.54), and
 * journaling every write there would cost a write for nothing. The supervisor turns it on for a
 * master linked at Full, with the bulk transport (P3-2).
 */
import { config, nodeRole } from 'config'
import { logger } from '../../logger/logger.js'
import { enableOrgs, ensureCapturable, establishToken, holderId, LeaseLostError, releaseLease, tail, takeLease } from './capture.js'

const me = holderId()
let running: Promise<void> | null = null
let abort: AbortController | null = null

/** Whether this process captures at all. */
export function captureOn(): boolean {
  return nodeRole() === 'master' && config.replication.capture
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
  if (!captureOn()) return { tailing: false, enabled: 0 }
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

/** Stop tailing and give the lease back (a graceful stop, tests). */
export async function stopCapture(): Promise<void> {
  abort?.abort()
  await running
  if (captureOn()) {
    const { db } = await handles()
    await releaseLease(db, me).catch(() => {})
  }
}
