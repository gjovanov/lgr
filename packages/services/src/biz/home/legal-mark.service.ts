/**
 * A mark of the legal counters, kept OUTSIDE the database, on every master (FR-20.51, plan A.7.5,
 * gjovanov/lgr#549).
 *
 * A database put back from outside the app (a copied data folder, a dump, a disk image, a VM
 * snapshot) brings its counters back with it: the server would issue again the invoice numbers, cash
 * sales and УНП it already gave customers, and Н-18 wants each of them once. The journal's own mark
 * (`journalHwmTick`) cannot see that on an Air-gapped master, which captures nothing, so its `seq`
 * never grows. This mark watches the counters themselves, whatever `captureOn()` says:
 *
 * - **Beside the node token** (`state/legal-mark.json`), never inside the database it watches: per
 *   org written here, per legal series (`prefix|year`, as `legalCounters` reads them), the highest
 *   counter this server's database was seen to hold. Checked at the API's start, before it serves,
 *   and every minute (`series-lock-tick`).
 * - **A copy on the backup drive** (`<BACKUP_LOCAL_PATH>/LGR/State/legal-mark-<node>.json`), where
 *   a master's nightly copies go: restoring a system-disk image takes the mark beside the database
 *   back with it, and leaves the backup drive alone. Used only where the location is there and NOT on
 *   the data's own disk (the rule `pushBundleToLocalPath` applies: an unplugged drive leaves an empty
 *   mount point on the system disk, and a copy there goes back with the disk). The base path is never
 *   created.
 * - **The mark is the higher of the two, series by series.** A counter below it means the database
 *   went back, and legal numbering LOCKS (`restored`) until a person records the last numbers; the
 *   unlock resumes above the mark too (`recordLastNumbers`). A counter above it raises it. A mark is
 *   never lowered, and an older copy (a rotated drive brought back) is simply brought up to date:
 *   only a database BELOW a mark locks anything.
 * - **Only an org written here and `active`.** A move into this server or a re-seed replaces the
 *   org's data while it is `frozen` (`move-worker.service.ts`), and the import's empty counters read
 *   against an earlier stay's mark would lock an org arriving whole.
 *
 * What it cannot see: a revert of the database AND of the backup drive, or a server with no backup
 * drive whose whole disk went back. The runbook's procedure covers that (lock numbering by hand
 * before selling, `POST /numbering/lock`; docs/guides/server-install.md). The window is a minute:
 * numbers issued after the last tick and before the image was taken are the fiscal device's evidence
 * for the person, as ever (`device-witness.service.ts`).
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { config, nodeRole } from 'config'
import { OrgHome } from 'db/models'
import { thisNode } from 'db/home/home'
import { logger } from '../../logger/logger.js'
import { localDisk } from '../backup/backup-destinations.service.js'
import { legalCounterKey, legalCounters } from '../sequence.service.js'
import { lockLegalSeries } from './series-lock.service.js'

/** Which copy held a series' mark: the one beside the database, or the backup drive's. */
export type MarkSource = 'local' | 'drive'

interface SeriesMark { last: number; at: string }
interface MarkFile { v: 1; node: string; orgs: Record<string, Record<string, SeriesMark>> }
type Merged = Record<string, Record<string, SeriesMark & { from: MarkSource }>>

/** No real counter goes past these (a УНП is 7 digits): a mark beyond one is damage, never a floor. */
const UNP_MAX = 9_999_999
const SERIES_MAX = 999_999_999

/** Beside the node token, in the server's state: the supervisor names that file whether it exists or not. */
export function legalMarkFile(): string | null {
  const token = config.outbox.tokenFile
  return token ? join(dirname(token), 'legal-mark.json') : null
}

/** The backup drive's copy, where it may be kept now, or why not. Null `file` and no `why`: none is configured. */
async function driveTarget(): Promise<{ file: string | null; why?: string }> {
  const base = config.backup.localPath
  if (!base) return { file: null }
  const node = thisNode()
  if (!node) return { file: null, why: 'this server has no node id yet' }
  if (!(await stat(base).then(s => s.isDirectory(), () => false))) {
    return { file: null, why: `the backup location ${base} is not there (a drive unplugged, or a share down)` }
  }
  if (await localDisk.sameAsData(base)) {
    return { file: null, why: `the backup location ${base} is on this server's own disk, where a copy goes back with the disk` }
  }
  return { file: join(base, 'LGR', 'State', `legal-mark-${node.replace(/[^A-Za-z0-9._-]/g, '_')}.json`) }
}

/** What a mark file holds, every entry checked; `error` when there is a file and it is no mark. */
async function readMark(file: string): Promise<{ mark: MarkFile | null; error?: string }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e: any) {
    return e?.code === 'ENOENT' ? { mark: null } : { mark: null, error: e?.message ?? String(e) }
  }
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (e: any) {
    return { mark: null, error: `not JSON: ${e?.message ?? e}` }
  }
  if (!raw || typeof raw !== 'object' || !raw.orgs || typeof raw.orgs !== 'object') return { mark: null, error: 'not a mark of legal counters' }
  const orgs: MarkFile['orgs'] = {}
  for (const [org, series] of Object.entries<any>(raw.orgs)) {
    if (!/^[0-9a-f]{24}$/.test(org) || !series || typeof series !== 'object') continue
    for (const [key, m] of Object.entries<any>(series)) {
      const cut = key.lastIndexOf('|')
      const prefix = key.slice(0, cut)
      const year = Number(key.slice(cut + 1))
      const last = Number(m?.last)
      if (cut < 1 || !Number.isSafeInteger(year) || legalCounterKey(prefix, year) !== key) continue
      if (!Number.isSafeInteger(last) || last < 0 || last > (prefix.startsWith('UNP-') ? UNP_MAX : SERIES_MAX)) continue
      ;(orgs[org] ??= {})[key] = { last, at: typeof m?.at === 'string' ? m.at : new Date(0).toISOString() }
    }
  }
  return { mark: { v: 1, node: typeof raw.node === 'string' ? raw.node : '', orgs } }
}

/** The higher of the two copies, series by series; on a tie, the one beside the database. */
function merge(local: MarkFile | null, drive: MarkFile | null): Merged {
  const out: Merged = {}
  for (const [copy, from] of [[local, 'local'], [drive, 'drive']] as const) {
    for (const [org, series] of Object.entries(copy?.orgs ?? {})) {
      for (const [key, m] of Object.entries(series)) {
        const held = out[org]?.[key]
        if (!held || m.last > held.last) (out[org] ??= {})[key] = { ...m, from }
      }
    }
  }
  return out
}

/** The file as written: keys sorted, so two marks holding the same compare equal as text. */
function canonical(node: string, orgs: Record<string, Record<string, SeriesMark>>): string {
  const sorted: MarkFile['orgs'] = {}
  for (const org of Object.keys(orgs).sort()) {
    sorted[org] = {}
    for (const key of Object.keys(orgs[org]).sort()) sorted[org][key] = { last: orgs[org][key].last, at: orgs[org][key].at }
  }
  return JSON.stringify({ v: 1, node, orgs: sorted })
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

/** A warning when a condition starts, and a line when it ends: never one a minute. */
const conditions = new Map<string, string>()
function condition(key: string, now: string | null, warn: (text: string) => void, ended?: string) {
  const was = conditions.get(key) ?? null
  if (now === was) return
  if (now) {
    conditions.set(key, now)
    warn(now)
  } else {
    conditions.delete(key)
    if (ended) logger.info({ condition: key }, ended)
  }
}

const label = (key: string) => key.replace('|', ' ')

/**
 * Compare each active org's legal counters with the mark: below it, the database went back and the
 * org's legal series lock (the mark stays, as the evidence); above it, the mark moves up. Then both
 * copies are written, where they differ from it. Returns how many orgs it locked. Never throws.
 */
async function tick(now: Date): Promise<number> {
  if (nodeRole() !== 'master') return 0
  const file = legalMarkFile()
  if (!file) return 0
  const node = thisNode()
  try {
    const homes: any[] = await OrgHome.find({ home: node, state: 'active' }, { orgId: 1 }).lean()
    const local = await readMark(file)
    if (local.error) {
      // Kept aside, never overwritten: a mark that cannot be read is still somebody's evidence.
      await rename(file, `${file}.unreadable`).catch(() => {})
      logger.error({ file, err: local.error }, 'Legal mark: the mark beside the database could not be read; it is kept aside and a new one starts from the backup drive\'s copy and the counters')
    }
    const drive = await driveTarget()
    condition('drive', drive.why ?? null, why => logger.warn({ why }, 'Legal mark: no copy on the backup drive, so a restore of the whole system disk would go unseen'), 'Legal mark: the copy on the backup drive is kept again')
    const copy = drive.file ? await readMark(drive.file) : { mark: null }
    condition('drive-read', copy.error ?? null, err => logger.warn({ file: drive.file, err }, 'Legal mark: the backup drive\'s copy could not be read; it is written again'))
    // A copy of another server's mark is no evidence about this one.
    const driveMark = copy.mark && copy.mark.node === node ? copy.mark : null
    const merged = merge(local.mark, driveMark)

    const counters = new Map<string, Map<string, number>>()
    for (const c of await legalCounters(homes.map(h => h.orgId))) {
      const held = counters.get(c.orgId) ?? new Map<string, number>()
      held.set(`${c.prefix}|${c.year}`, c.last)
      counters.set(c.orgId, held)
    }

    let locked = 0
    for (const h of homes) {
      const org = String(h.orgId)
      const marks = merged[org] ?? {}
      const held = counters.get(org) ?? new Map<string, number>()
      const below = Object.entries(marks).filter(([key, m]) => (held.get(key) ?? 0) < m.last)
      if (below.length) {
        const shown = below.slice(0, 3).map(([key, m]) =>
          `${label(key)} is at ${held.get(key) ?? 0} here, and this server had issued up to ${m.last} (${m.from === 'drive' ? 'its mark on the backup drive' : 'its mark beside the database'})`)
        const detail = `${shown.join('; ')}${below.length > 3 ? `; and ${below.length - 3} more series` : ''}: the database went back`
        if (await lockLegalSeries(org, 'restored', detail, now)) locked++
        continue
      }
      for (const [key, last] of held) {
        const m = marks[key]
        if (!m || last > m.last) (merged[org] ??= {})[key] = { last, at: now.toISOString(), from: 'local' }
      }
    }

    const text = canonical(node, merged)
    if (!local.mark || local.error || text !== canonical(node, local.mark.orgs)) {
      await writeAtomic(file, text).then(
        () => condition('local-write', null, () => {}, 'Legal mark: the mark beside the database is written again'),
        (e: any) => condition('local-write', e?.message ?? String(e), err => logger.error({ file, err }, 'Legal mark: the mark beside the database could not be written')),
      )
    }
    if (drive.file && (!driveMark || text !== canonical(node, driveMark.orgs))) {
      await writeAtomic(drive.file, text).then(
        () => condition('drive-write', null, () => {}, 'Legal mark: the copy on the backup drive is written again'),
        (e: any) => condition('drive-write', e?.message ?? String(e), err => logger.warn({ file: drive.file, err }, 'Legal mark: the copy on the backup drive could not be written')),
      )
    }
    condition('tick', null, () => {}, 'Legal mark: checked again')
    return locked
  } catch (e: any) {
    condition('tick', e?.message ?? String(e), err => logger.error({ err }, 'Legal mark: the legal counters could not be checked against their mark'))
    return 0
  }
}

let chain: Promise<number> = Promise.resolve(0)
/**
 * One tick at a time (the start's check and the scheduler's first run land together): a later one
 * reads what the earlier one wrote. Returns how many orgs it locked. Never throws.
 */
export function legalMarkTick(now = new Date()): Promise<number> {
  const run = chain.then(() => tick(now))
  chain = run.catch(() => 0)
  return run
}

/**
 * This server's mark of what it issued for one org, both copies merged: the floor numbering resumes
 * above at the unlock, and what the person is shown. Empty off a master. Never throws.
 */
export async function legalMarkOf(orgId: string): Promise<Array<{ prefix: string; year: number; last: number; from: MarkSource }>> {
  if (nodeRole() !== 'master') return []
  const file = legalMarkFile()
  if (!file) return []
  try {
    const node = thisNode()
    const local = await readMark(file)
    const drive = await driveTarget()
    const copy = drive.file ? await readMark(drive.file) : { mark: null }
    const merged = merge(local.mark, copy.mark && copy.mark.node === node ? copy.mark : null)
    return Object.entries(merged[String(orgId)] ?? {})
      .map(([key, m]) => ({ prefix: key.slice(0, key.lastIndexOf('|')), year: Number(key.slice(key.lastIndexOf('|') + 1)), last: m.last, from: m.from }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.year - b.year)
  } catch (e: any) {
    logger.warn({ orgId, err: e?.message ?? String(e) }, 'Legal mark: the mark could not be read')
    return []
  }
}
