/**
 * A database that went back in time locks its legal series (FR-20.51, FR-20.71, plan step P3-7):
 * sales documents, cash sales and each fiscal device's УНП (`LEGAL_SERIES`), until a person records
 * the last numbers the site issued and numbering resumes above them. The lock is the one a promotion
 * sets (`OrgHome.seriesFrozen`, P3-6d), with its reason; `assertSeriesOpen` enforces it wherever a
 * legal number is drawn, and every issuing path refuses before it moves anything.
 *
 * What locks it, on a master, for an org written there:
 * - **An in-app restore** of the org (FR-13, `applyRestore`).
 * - **The journal behind its own high-water mark.** The capture's per-org `seq` only ever grows in a
 *   database that was never rewound, so a mark kept OUTSIDE the database (a file beside the node
 *   token) that the database falls below means the database was restored or reverted. Checked at the
 *   API's start, before it serves, and every minute.
 * - **lgrai.app refusing its pages as a history that went back** (`instance_changed`,
 *   `stale_journal`, `diverged`): a reverted VM snapshot written to, when linked.
 * - **A clone alarm**: another machine connected as this server (FR-20.8).
 *
 * ⚠ **A signal from before the last unlock does not lock again.** A person who recorded the last
 * numbers made numbering safe; replication may stay refused until the org is re-seeded, and the
 * journal may stay below the old mark for a while. So the unlock is remembered (`seriesUnlockedAt`)
 * and resets the mark, and only a newer signal locks.
 *
 * Not yet: the fiscal device as a witness (its last receipt ahead of the database), the clone seen
 * on the LAN, and the re-seed from the mirror.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { mongo } from 'mongoose'
import { config, nodeRole } from 'config'
import { mongoose } from 'db/connection'
import { OrgHome, ReplOrg } from 'db/models'
import { thisNode } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { fetchWithTimeout } from '../outbound-fetch.js'
import { readNodeToken } from '../relay/outbox-worker.js'

type ObjectId = mongo.ObjectId
const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v)) as unknown as ObjectId

export type SeriesLockReason = 'promoted' | 'restored' | 'went_back' | 'clone'
/** What lgrai.app answers a master's pages when its history went back. */
export const WENT_BACK_REFUSALS: ReadonlySet<string> = new Set(['instance_changed', 'stale_journal', 'diverged'])

/**
 * Lock the org's legal series here, unless they are locked already. Only where the org is written:
 * a lock anywhere else would freeze nothing it issues.
 */
export async function lockLegalSeries(orgId: string, reason: SeriesLockReason, detail?: string, at = new Date()): Promise<boolean> {
  const r = await OrgHome.updateOne(
    { orgId: oid(orgId), home: thisNode(), 'seriesFrozen.since': { $exists: false } },
    { $set: { seriesFrozen: { since: at, reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) } } },
  )
  if (r.modifiedCount) logger.error({ orgId, reason, detail }, 'Legal numbering is LOCKED here until a person records the last numbers issued at the site')
  return r.modifiedCount > 0
}

// ── The journal's high-water mark, kept outside the database ─────────────────────────────────────

/** Beside the node token, in the server's state: never inside the database it watches. */
export function hwmFile(): string | null {
  const token = config.outbox.tokenFile
  return token ? join(dirname(token), 'journal-hwm.json') : null
}

type Hwm = Record<string, { seq: number; at: string }>

async function readHwm(file: string): Promise<Hwm> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

async function writeHwm(file: string, hwm: Hwm): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(hwm))
  await rename(tmp, file)
}

/**
 * Compare each home org's journal with the mark: below it, the database went back, and its series
 * lock (the mark stays, as the evidence, until a person records the last numbers). Above it, the
 * mark moves up. Returns how many orgs it locked.
 */
export async function journalHwmTick(now = new Date()): Promise<number> {
  if (nodeRole() !== 'master') return 0
  const file = hwmFile()
  if (!file) return 0
  const homes: any[] = await OrgHome.find({ home: thisNode() }, { orgId: 1 }).lean()
  if (!homes.length) return 0
  const hwm = await readHwm(file)
  const rows: any[] = await ReplOrg.find({ orgId: { $in: homes.map(h => h.orgId) } }, { orgId: 1, seq: 1 }).lean()
  let locked = 0
  let moved = false
  for (const r of rows) {
    const key = String(r.orgId)
    const seen = Number(hwm[key]?.seq ?? 0)
    const seq = Number(r.seq ?? 0)
    if (seq < seen) {
      if (await lockLegalSeries(key, 'restored', `the journal is at ${seq}, and this server had journaled up to ${seen}: the database went back`, now)) locked++
      continue
    }
    if (seq > seen) {
      hwm[key] = { seq, at: now.toISOString() }
      moved = true
    }
  }
  if (moved) await writeHwm(file, hwm)
  return locked
}

/** After a person recorded the last numbers: the mark starts again from where the journal is. */
export async function resetJournalHwm(orgId: string, now = new Date()): Promise<void> {
  const file = hwmFile()
  if (nodeRole() !== 'master' || !file) return
  const hwm = await readHwm(file)
  const row: any = await ReplOrg.findOne({ orgId: oid(orgId) }, { seq: 1 }).lean()
  hwm[String(orgId)] = { seq: Number(row?.seq ?? 0), at: now.toISOString() }
  await writeHwm(file, hwm)
}

// ── What lgrai.app says of this server ───────────────────────────────────────────────────────────

/**
 * Ask lgrai.app what it holds against this server: a clone alarm, and orgs whose pages it refuses as
 * a history that went back. Each locks the org's series here, if it is newer than the last unlock.
 */
export async function linkAlarmsTick(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<number> {
  if (nodeRole() !== 'master') return 0
  const token = readNodeToken()
  if (!token) return 0
  const res = await fetchWithTimeout(new URL('/api/node/v1/self', token.server), { headers: { authorization: `Bearer ${token.token}` } }, { timeoutMs: 15_000, fetchImpl })
  if (!res.ok) return 0
  const self: any = await res.json().catch(() => ({}))
  const homes: any[] = await OrgHome.find({ home: thisNode() }, { orgId: 1, seriesUnlockedAt: 1 }).lean()
  let locked = 0
  for (const h of homes) {
    const key = String(h.orgId)
    const since = h.seriesUnlockedAt ? new Date(h.seriesUnlockedAt).getTime() : 0
    if (self.cloneAlarm?.at && new Date(self.cloneAlarm.at).getTime() > since) {
      if (await lockLegalSeries(key, 'clone', 'another machine is connected to lgrai.app as this server', now)) locked++
      continue
    }
    const back = (self.wentBack ?? []).find((w: any) => w.orgId === key)
    if (back?.at && new Date(back.at).getTime() > since) {
      if (await lockLegalSeries(key, 'went_back', `lgrai.app refuses this server's pages: ${back.reason}`, now)) locked++
    }
  }
  return locked
}

/**
 * The legal series as lgrai.app's mirror holds them, for an org of this server: the floor numbering
 * resumes above when linked (FR-20.51). Null when lgrai.app cannot be asked.
 */
export async function mirrorLegalSeries(orgId: string, fetchImpl: typeof fetch = fetch): Promise<Array<{ prefix: string; year: number; last: number }> | null> {
  if (nodeRole() !== 'master') return null
  const token = readNodeToken()
  if (!token) return null
  try {
    const res = await fetchWithTimeout(new URL(`/api/node/v1/legal-series?orgId=${encodeURIComponent(orgId)}`, token.server), { headers: { authorization: `Bearer ${token.token}` } }, { timeoutMs: 10_000, fetchImpl })
    if (!res.ok) return null
    const body: any = await res.json()
    return Array.isArray(body?.series) ? body.series : null
  } catch {
    return null
  }
}
