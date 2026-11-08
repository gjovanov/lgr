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
 * - **The drive is bounded** (`onDrive`): `BACKUP_LOCAL_PATH` may be a share, and a share whose
 *   server went away blocks a `stat` for good, while the API's start and the minute's other checks
 *   wait on this one. Past 10 s, or while an earlier operation there still hangs, the drive counts as
 *   not there for that tick; the mark beside the database and the counters are checked regardless.
 * - **An I/O error is not damage.** A mark that is no JSON, or no mark, is kept aside under a dated
 *   name and a new one starts. One that could not be READ (held by a backup tool or an antivirus, a
 *   permission) is left as it is and not written that minute, and the unlock refuses (503
 *   `mark_unreadable`) rather than resume below a floor it could not read.
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

/**
 * How long the backup location may take to answer one operation. A share whose server went away
 * blocks a `stat` for good (NFS `hard`, CIFS) or for a minute (a UNC path), and the API's start and
 * every detector of the minute wait on this tick.
 */
const DRIVE_TIMEOUT_MS = 10_000

/** The operation on the backup location still running, if one is: one a share stopped answering stays pending. */
let driveBusy: Promise<unknown> | null = null

/**
 * One operation on the backup location, bounded, and one at a time. Past the bound, or while an
 * earlier one still hangs in the thread pool, the drive counts as not there: a hung share holds
 * neither the start nor the minute's checks, and never stacks one more blocked thread a minute.
 * Never throws.
 */
async function onDrive<T>(base: string, op: () => Promise<T>): Promise<{ value: T } | { why: string }> {
  if (driveBusy) return { why: `the backup location ${base} has not answered an earlier request yet (a share that is down?)` }
  const run: Promise<{ value: T } | { why: string }> = Promise.resolve()
    .then(op)
    .then(value => ({ value }), (e: any) => ({ why: `the backup location ${base} failed: ${e?.message ?? e}` }))
  driveBusy = run
  void run.then(() => { if (driveBusy === run) driveBusy = null })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ why: string }>(resolve => {
    timer = setTimeout(() => resolve({ why: `the backup location ${base} did not answer within ${DRIVE_TIMEOUT_MS / 1000} s (a share that is down?)` }), DRIVE_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([run, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Where the backup drive's copy goes, or why it cannot. Run through `onDrive`: every call here may block. */
async function driveTarget(base: string): Promise<{ file: string | null; why?: string }> {
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

/**
 * The backup drive's copy (this server's only: another's says nothing of it) and where it is
 * written, bounded. No `file`: none is kept now, `why` says why; no `why` either, none is configured.
 * `damaged`: there is one and it is no mark, so it is written again.
 */
async function readDrive(): Promise<{ file: string | null; why?: string; mark: MarkFile | null; damaged?: string }> {
  const base = config.backup.localPath
  if (!base) return { file: null, mark: null }
  const got = await onDrive(base, async () => {
    const target = await driveTarget(base)
    return { ...target, read: target.file ? await readMark(target.file) : null }
  })
  if ('why' in got) return { file: null, why: got.why, mark: null }
  const { file, why, read } = got.value
  if (!file) return { file: null, why, mark: null }
  if (read?.ioError) return { file: null, why: `the copy on the backup drive could not be read: ${read.ioError}`, mark: null }
  return {
    file,
    mark: read?.mark && read.mark.node === thisNode() ? read.mark : null,
    ...(read?.damaged ? { damaged: read.damaged } : {}),
  }
}

/**
 * What a mark file holds, every entry checked. `damaged`: the file is there and is no mark (kept
 * aside, a new one starts). `ioError`: it could not be read at all (a backup tool or an antivirus
 * holding it, a permission), which says nothing of what it holds: never handled as damage.
 */
async function readMark(file: string): Promise<{ mark: MarkFile | null; damaged?: string; ioError?: string }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e: any) {
    return e?.code === 'ENOENT' ? { mark: null } : { mark: null, ioError: e?.message ?? String(e) }
  }
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (e: any) {
    return { mark: null, damaged: `not JSON: ${e?.message ?? e}` }
  }
  if (!raw || typeof raw !== 'object' || !raw.orgs || typeof raw.orgs !== 'object') return { mark: null, damaged: 'not a mark of legal counters' }
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
    // Damaged: kept aside under its own name, never overwritten (a mark that cannot be read is still
    // somebody's evidence), and a new one starts from the drive's copy and the counters.
    if (local.damaged) await rename(file, `${file}.unreadable-${now.toISOString().replace(/[:.]/g, '-')}`).catch(() => {})
    condition('local-damaged', local.damaged ?? null,
      err => logger.error({ file, err }, 'Legal mark: the mark beside the database is damaged; it is kept aside and a new one starts from the backup drive\'s copy and the counters'))
    // Not read at all: the file stays as it is and is not written this minute. The counters are still
    // held against the drive's copy, and against this file again once it reads.
    condition('local-io', local.ioError ?? null,
      err => logger.warn({ file, err }, 'Legal mark: the mark beside the database could not be read this minute; it is left as it is'),
      'Legal mark: the mark beside the database is read again')
    // Bounded: a share that does not answer is a drive not there, and the rest of the check goes on.
    const drive = await readDrive()
    condition('drive', drive.why ?? null, why => logger.warn({ why }, 'Legal mark: no copy on the backup drive, so a restore of the whole system disk would go unseen'), 'Legal mark: the copy on the backup drive is kept again')
    condition('drive-damaged', drive.damaged ?? null, err => logger.warn({ file: drive.file, err }, 'Legal mark: the backup drive\'s copy is damaged; it is written again'))
    const driveMark = drive.mark
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
    if (!local.ioError && (!local.mark || text !== canonical(node, local.mark.orgs))) {
      await writeAtomic(file, text).then(
        () => condition('local-write', null, () => {}, 'Legal mark: the mark beside the database is written again'),
        (e: any) => condition('local-write', e?.message ?? String(e), err => logger.error({ file, err }, 'Legal mark: the mark beside the database could not be written')),
      )
    }
    const driveFile = drive.file
    if (driveFile && (!driveMark || text !== canonical(node, driveMark.orgs))) {
      const wrote = await onDrive(config.backup.localPath, () => writeAtomic(driveFile, text))
      if ('why' in wrote) condition('drive-write', wrote.why, err => logger.warn({ file: driveFile, err }, 'Legal mark: the copy on the backup drive could not be written'))
      else condition('drive-write', null, () => {}, 'Legal mark: the copy on the backup drive is written again')
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

export interface LegalMarkSeries { prefix: string; year: number; last: number; from: MarkSource }

/**
 * This server's mark of what it issued for one org, both copies merged, and `unreadable` when the
 * one beside the database could not be read just now (an I/O error, never damage): the floor the
 * unlock resumes above must not quietly lose it. The drive is bounded (`onDrive`); a drive that does
 * not answer adds nothing. Empty off a master. Never throws.
 *
 * ⚠ In turn with the ticks (`chain`). `onDrive` lets one operation at a time at the drive, so a read
 * that landed while a tick was there found it busy and went without the drive's copy: after a system
 * disk went back, that copy is the only evidence of what was issued, and the unlock resumed above
 * the reverted mark beside the database instead. The tick then locked again a moment later, and a
 * sale in between was given a number already given.
 */
export function legalMarkFloor(orgId: string): Promise<{ series: LegalMarkSeries[]; unreadable?: string }> {
  const run = chain.then(() => readFloor(orgId))
  chain = run.then(() => 0, () => 0)
  return run
}

async function readFloor(orgId: string): Promise<{ series: LegalMarkSeries[]; unreadable?: string }> {
  if (nodeRole() !== 'master') return { series: [] }
  const file = legalMarkFile()
  if (!file) return { series: [] }
  try {
    const local = await readMark(file)
    const drive = await readDrive()
    const merged = merge(local.mark, drive.mark)
    const series = Object.entries(merged[String(orgId)] ?? {})
      .map(([key, m]) => ({ prefix: key.slice(0, key.lastIndexOf('|')), year: Number(key.slice(key.lastIndexOf('|') + 1)), last: m.last, from: m.from }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.year - b.year)
    return local.ioError ? { series, unreadable: local.ioError } : { series }
  } catch (e: any) {
    logger.warn({ orgId, err: e?.message ?? String(e) }, 'Legal mark: the mark could not be read')
    return { series: [], unreadable: e?.message ?? String(e) }
  }
}

/** The mark for one org, as `legalMarkFloor` reads it: what the person is shown beside the series. */
export async function legalMarkOf(orgId: string): Promise<LegalMarkSeries[]> {
  return (await legalMarkFloor(orgId)).series
}
