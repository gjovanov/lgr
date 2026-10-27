/**
 * A database that went back in time locks its legal series (FR-20.51, FR-20.71, plan step P3-7):
 * sales documents, cash sales and each fiscal device's УНП (`LEGAL_SERIES`), until a person records
 * the last numbers the site issued and numbering resumes above them. The lock is the one a promotion
 * sets (`OrgHome.seriesFrozen`, P3-6d), with its reason; `assertSeriesOpen` enforces it wherever a
 * legal number is drawn, and every issuing path refuses before it moves anything.
 *
 * What locks it, on a master, for an org written there:
 * - **An in-app Replace restore** of the org (FR-13, `applyRestore`). ⚠ Only where lgrai.app keeps
 *   no copy of it: on a server registered with lgrai.app a Replace is REFUSED (`replaceRefusedHere`),
 *   because its writes are journaled like any other and its pages would take the mirror back in time
 *   with it. A Merge only adds what is missing and never lowers a counter: it locks nothing.
 * - **The journal behind its own high-water mark.** The capture's per-org `seq` only ever grows in a
 *   database that was never rewound, so a mark kept OUTSIDE the database (a file beside the node
 *   token) that the database falls below means the database was restored or reverted. Checked at the
 *   API's start, before it serves, and every minute.
 * - **The journal behind lgrai.app's watermark**: the other mark kept outside, by global. A healthy
 *   master is never behind the pages it sent. ⚠ This is what catches a reverted VM snapshot, whose
 *   own mark went back with the disk.
 * - **lgrai.app holding pages of the org past the newest this database ever built** (`buildPage`,
 *   when the pump asks): a restored database whose chain the master can no longer continue. Its pump
 *   stops that org (`chain_unknown`) without a word to global, so this is the master's own finding.
 * - **lgrai.app refusing its pages as a history that went back** (`instance_changed`,
 *   `stale_journal`, `diverged`): a reverted VM snapshot written to, when linked.
 * - **A clone alarm**: another machine connected as this server (FR-20.8).
 *
 * ⚠ **A sign seen again does not lock again.** A person who recorded the last numbers made numbering
 * safe, while replication stays refused until the org is re-seeded, the journal may stay below its
 * marks a while, and lgrai.app dates every refusal of the same history anew. So a history that went
 * back underneath the mirror is RECORDED once (`noteWentBack`, `repl_orgs.wentBack`, cleared by the
 * re-seed), the unlock resets this server's own mark, and a clone alarm counts only when it is newer
 * than the unlock (`seriesUnlockedAt`).
 *
 * Every minute the master also tells lgrai.app what it found, per org (`reportOrgState`), for the
 * Servers page there. Not yet: the fiscal device as a witness (its last receipt ahead of the
 * database), the clone seen on the LAN, and the re-seed from the mirror.
 */
import { readFileSync } from 'node:fs'
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
import { captureOn } from '../replication/engine.js'

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

/**
 * This database cannot continue lgrai.app's copy of `orgId`: it went back underneath it (FR-20.51,
 * FR-20.71). Recorded ONCE on the org's journal row (`repl_orgs.wentBack`), and legal numbering locks
 * with it. ⚠ The record, not the sign, decides: the pump sends the refused history again on every new
 * session, and lgrai.app dates each refusal anew, so a sign seen again after a person recorded the
 * numbers must find the record and change nothing. A re-seed from the mirror clears it. True when this
 * was the first sign.
 */
export async function noteWentBack(orgId: string, reason: string, detail: string, now = new Date()): Promise<boolean> {
  if (nodeRole() !== 'master') return false
  const org = oid(orgId)
  if (!(await OrgHome.exists({ orgId: org, home: thisNode() }))) return false
  const r = await ReplOrg.collection.updateOne({ orgId: org, wentBack: { $exists: false } }, { $set: { wentBack: { at: now, reason: reason.slice(0, 40), detail: detail.slice(0, 500) } } })
  if (!r.modifiedCount) return false
  logger.error({ orgId, reason, detail }, 'Replication: this database cannot continue lgrai.app\'s copy of the organisation; it went back underneath it')
  await lockLegalSeries(orgId, 'went_back', detail, now)
  return true
}

// ── A restore on a master ────────────────────────────────────────────────────────────────────────

/** Whether this server is registered with lgrai.app, at any link level: its registration on record. */
function registeredWithLgrai(): boolean {
  const file = config.replication.registrationFile
  if (!file) return false
  try {
    return typeof JSON.parse(readFileSync(file, 'utf8'))?.linkLevel === 'string'
  } catch {
    return false
  }
}

export const REPLACE_REFUSED =
  'On a server registered with lgrai.app, Replace is refused: lgrai.app keeps a copy of this organisation, and a restore ' +
  'here would take the server back in time underneath it, then send that history to the copy. To go back to a backup, move ' +
  'the organisation to lgrai.app and restore it there. Merge, which only adds what is missing, stays available.'

/**
 * FR-20.51, FR-20.71 (P3-7): why a restore of `orgId` may not run on this master, or null. A Replace
 * deletes and rewrites the org's documents, and the capture journals that like any other write: where
 * lgrai.app keeps a copy (the server is registered, captures, or has paged the org), the pages would
 * carry the backup's state to it, deleting there what the backup lacks. Only a server lgrai.app has
 * never known restores by Replace, and its legal series lock.
 */
export async function replaceRefusedHere(orgId: string, mode: string): Promise<string | null> {
  if (nodeRole() !== 'master' || mode !== 'replace') return null
  if (captureOn() || registeredWithLgrai()) return REPLACE_REFUSED
  return (await ReplOrg.exists({ orgId: oid(orgId), 'pages.0': { $exists: true } })) ? REPLACE_REFUSED : null
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

// ── A clone on the shop's network (AC 50) ────────────────────────────────────────────────────────

/** `state/clone.json`, beside the node token: where the supervisor records a clone it saw on the LAN. */
export function cloneFile(): string | null {
  const token = config.outbox.tokenFile
  return token ? join(dirname(token), 'clone.json') : null
}

/**
 * Another machine on this server's network answering as it, holding its keys, as the supervisor
 * recorded it (`packages/server/src/lan_clone.rs`: an advert of this node from another start, at
 * another address, whose LAN ingress completes a handshake with this server's CA). Locks legal numbering
 * where an org is written, if seen since the last unlock: the record's `at` is renewed at every
 * sighting, so a clone still answering after a person recorded the numbers locks it again. Returns how
 * many orgs it locked.
 */
export async function lanCloneTick(now = new Date()): Promise<number> {
  if (nodeRole() !== 'master') return 0
  const file = cloneFile()
  if (!file) return 0
  let seen: any
  try {
    seen = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return 0
  }
  const at = seen?.at ? new Date(seen.at).getTime() : Number.NaN
  if (!Number.isFinite(at)) return 0
  const homes: any[] = await OrgHome.find({ home: thisNode() }, { orgId: 1, seriesUnlockedAt: 1 }).lean()
  let locked = 0
  for (const h of homes) {
    if (at <= (h.seriesUnlockedAt ? new Date(h.seriesUnlockedAt).getTime() : 0)) continue
    const detail = `another machine on this server's network answers as it, with its keys (${String(seen.otherIp ?? 'unknown')}), since ${String(seen.firstSeen ?? seen.at)}`
    if (await lockLegalSeries(String(h.orgId), 'clone', detail, now)) locked++
  }
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
 * Ask lgrai.app what it holds against this server: a clone alarm, orgs whose pages it refuses as a
 * history that went back, and how far it holds each org's journal. Each locks the org's series here,
 * if it is newer than the last unlock.
 */
export async function linkAlarmsTick(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<number> {
  if (nodeRole() !== 'master') return 0
  const token = readNodeToken()
  if (!token) return 0
  const res = await fetchWithTimeout(new URL('/api/node/v1/self', token.server), { headers: { authorization: `Bearer ${token.token}` } }, { timeoutMs: 15_000, fetchImpl })
  if (!res.ok) return 0
  const self: any = await res.json().catch(() => ({}))
  const homes: any[] = await OrgHome.find({ home: thisNode() }, { orgId: 1, seriesUnlockedAt: 1 }).lean()
  if (!homes.length) return 0
  const heads = new Map<string, number>(
    ((await ReplOrg.find({ orgId: { $in: homes.map(h => h.orgId) } }, { orgId: 1, seq: 1 }).lean()) as any[]).map(r => [String(r.orgId), Number(r.seq ?? 0)]),
  )
  let locked = 0
  for (const h of homes) {
    const key = String(h.orgId)
    const since = h.seriesUnlockedAt ? new Date(h.seriesUnlockedAt).getTime() : 0
    if (self.cloneAlarm?.at && new Date(self.cloneAlarm.at).getTime() > since) {
      if (await lockLegalSeries(key, 'clone', 'another machine is connected to lgrai.app as this server', now)) locked++
      continue
    }
    // A history that went back is recorded once (`noteWentBack`): seen again, it changes nothing.
    const back = (self.wentBack ?? []).find((w: any) => w.orgId === key)
    if (back?.reason) {
      if (await noteWentBack(key, String(back.reason), `lgrai.app refuses this server's pages: ${back.reason}`, now)) locked++
      continue
    }
    const mirror = (self.mirrors ?? []).find((m: any) => m.orgId === key)
    const head = heads.get(key)
    const watermark = Number(mirror?.watermark ?? 0)
    if (head !== undefined && head < watermark) {
      if (await noteWentBack(key, 'mirror_ahead', `lgrai.app holds this server's journal of the organisation up to ${watermark}, and it is at ${head} here: the database went back`, now)) locked++
    }
  }
  return locked
}

/**
 * What this server tells lgrai.app of each org written here (P3-7), every minute: where its journal
 * stands, whether its database went back underneath the mirror, and whether legal numbering is locked
 * and why. lgrai.app's Servers page shows it to the org's admin. False when lgrai.app cannot be told.
 */
export async function reportOrgState(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (nodeRole() !== 'master') return false
  const token = readNodeToken()
  if (!token) return false
  const homes: any[] = await OrgHome.find({ home: thisNode() }, { orgId: 1, seriesFrozen: 1 }).lean()
  const repl = new Map(((await ReplOrg.find({ orgId: { $in: homes.map(h => h.orgId) } }, { orgId: 1, seq: 1, wentBack: 1 }).lean()) as any[]).map(r => [String(r.orgId), r]))
  const orgs = homes.map(h => {
    const r: any = repl.get(String(h.orgId))
    return {
      orgId: String(h.orgId),
      head: Number(r?.seq ?? 0),
      ...(r?.wentBack?.at ? { wentBack: { at: r.wentBack.at, reason: r.wentBack.reason, detail: r.wentBack.detail } } : {}),
      ...(h.seriesFrozen?.since ? { numbering: { since: h.seriesFrozen.since, reason: h.seriesFrozen.reason, detail: h.seriesFrozen.detail } } : {}),
    }
  })
  const res = await fetchWithTimeout(
    new URL('/api/node/v1/org-state', token.server),
    { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ orgs }) },
    { timeoutMs: 15_000, fetchImpl },
  )
  return res.ok
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
