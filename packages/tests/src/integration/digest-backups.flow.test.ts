import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { config } from 'config'
import { BackupRun } from 'db/models'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { readBackupStatus, backupStatusDir } from 'services/biz/backup/backup-status.service'
import { renderDigestHtml } from 'services/biz/digest/daily-digest.render'
import { isSectionError } from 'services/biz/digest/daily-digest.types'
import type { Types } from 'mongoose'

/**
 * FR-13.6 (#24) — the Backups section of the daily digest.
 *
 * The thing under test is not really "does it render a table". It is: **can this section ever
 * turn silence into good news?** roomler's uploads backup has produced zero snapshots since
 * installation because nothing distinguished "no problems" from "no information". Every test
 * below that asserts `healthy === false` is guarding that distinction.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const DAY = '2026-09-02'
let TMP = ''

beforeAll(async () => {
  await setupTestDB()
  // Point the reader at a throwaway directory, exactly as doc-store.flow.test.ts does.
  TMP = mkdtempSync(join(tmpdir(), 'lgr-backup-status-'))
  config.backup.statusDir = TMP
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => {
  await clearCollections()
  rmSync(join(TMP, 'verify.json'), { force: true })
}, 30_000)

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

/**
 * A verification report shaped exactly as `verify-backups.sh` writes it.
 * `over` merges one level into the document and two into `detail`/`detail.summary`, so a test
 * can override one figure without restating the whole report.
 */
function writeReport(over: any = {}) {
  const { detail: dOver = {}, ...topOver } = over
  const { summary: sOver, ...detailOver } = dOver

  const summary = {
    latestFull: { artifact: 'lgr-2026-09-03.archive.zst', bytes: 3_355_443, ageHours: 2 },
    generations: { daily: 14, weekly: 8, monthly: 3, yearly: 0 },
    delta: { slices: 96, ageHours: 1 },
    uploads: { snapshots: 14, files: 946, ageHours: 3 },
    offsite: { reached: ['b2:lgr-backups', 'gjovanov@jupiter:/data/backup/lgr'], ageHours: 2 },
    ...(sOver || {}),
  }
  const doc = {
    job: 'verify',
    result: 'ok',
    at: hoursAgo(2),
    host: 'mars',
    ...topOver,
    detail: {
      checks: [
        { check: 'mongo.age', result: 'pass', detail: 'latest: lgr-2026-09-03.archive.zst (3.2MB, 2h ago)' },
        { check: 'mongo.integrity', result: 'pass', detail: 'zstd -t validated all 14 archives' },
        { check: 'uploads.count', result: 'pass', detail: 'uploads: 14 snapshots, latest holds 946 files' },
      ],
      failures: 0,
      lastRestore: { result: 'pass', at: hoursAgo(30), collections: 107, seconds: 51 },
      ...detailOver,
      summary,
    },
  }
  writeFileSync(join(TMP, 'verify.json'), JSON.stringify(doc))
  return doc
}

const orgWithBackups = (on: boolean) => createTestOrg({
  settings: { locale: 'bg', timezone: 'Europe/Sofia', dailyDigest: { sections: { backups: on } } },
} as any)

describe('backup status reader (FR-13.6)', () => {
  it('resolves under UPLOAD_DIR when no explicit dir is configured', () => {
    const saved = config.backup.statusDir
    config.backup.statusDir = ''
    expect(backupStatusDir()).toBe(join(config.upload.dir, '.backup-status'))
    config.backup.statusDir = saved
  })

  it('reads a healthy report into every figure FR-13.6 names', async () => {
    writeReport()
    const b = await readBackupStatus()

    expect(b.healthy).toBe(true)
    expect(b.gap).toBeUndefined()
    expect(b.latestFull).toEqual({ artifact: 'lgr-2026-09-03.archive.zst', bytes: 3_355_443, ageHours: 2 })
    expect(b.generations).toEqual({ daily: 14, weekly: 8, monthly: 3, yearly: 0 })
    expect(b.offsite?.reached).toEqual(['b2:lgr-backups', 'gjovanov@jupiter:/data/backup/lgr'])
    expect(b.lastRestore?.result).toBe('pass')
    expect(b.lastRestore?.collections).toBe(107)
    expect(b.failures).toEqual([])
    expect(b.checkCount).toBe(3)
    expect(b.host).toBe('mars')
  })

  // ── The four ways of learning nothing. None of them may read as healthy. ──

  it('a report that has NEVER arrived is a failure, not an absence', async () => {
    const b = await readBackupStatus()
    expect(b.healthy).toBe(false)
    expect(b.gap).toBe('never_reported')
  })

  it('a report that stopped arriving is a failure', async () => {
    writeReport({ at: hoursAgo(70) })
    const b = await readBackupStatus()
    expect(b.healthy).toBe(false)
    expect(b.gap).toBe('stale')
    expect(b.reportAgeHours).toBeGreaterThan(25)
  })

  it('unparseable JSON is a failure', async () => {
    writeFileSync(join(TMP, 'verify.json'), '{ this is not json')
    const b = await readBackupStatus()
    expect(b.healthy).toBe(false)
    expect(b.gap).toBe('unreadable')
  })

  it('a report with no timestamp is a failure', async () => {
    writeFileSync(join(TMP, 'verify.json'), JSON.stringify({ job: 'verify', result: 'ok' }))
    const b = await readBackupStatus()
    expect(b.healthy).toBe(false)
    expect(b.gap).toBe('unreadable')
  })

  it('never throws — it returns a state instead', async () => {
    const saved = config.backup.statusDir
    config.backup.statusDir = join(TMP, 'no', 'such', 'place')
    const b = await readBackupStatus()   // plain await: a throw would fail the test outright
    expect(b.healthy).toBe(false)
    config.backup.statusDir = saved
  })

  it('carries the failing checks through, and drops the passing ones', async () => {
    writeReport({
      result: 'fail',
      detail: {
        failures: 2,
        checks: [
          { check: 'mongo.age', result: 'pass', detail: 'fine' },
          { check: 'uploads.count', result: 'fail', detail: 'total uploads snapshots: 0' },
          { check: 'offsite', result: 'warn', detail: 'off-site push has never run' },
        ],
      },
    })
    const b = await readBackupStatus()
    expect(b.healthy).toBe(false)
    expect(b.failures.map(f => f.check)).toEqual(['uploads.count', 'offsite'])
    expect(b.failures[0].detail).toContain('snapshots: 0')
    expect(b.checkCount).toBe(3)
  })

  it('reports a failed restore test as failed', async () => {
    writeReport({ result: 'fail', detail: { lastRestore: { result: 'fail', at: hoursAgo(5) } } })
    const b = await readBackupStatus()
    expect(b.lastRestore?.result).toBe('fail')
    expect(b.healthy).toBe(false)
  })

  it('a report with no restore test yet leaves lastRestore unset', async () => {
    writeReport({ detail: { lastRestore: null } })
    const b = await readBackupStatus()
    expect(b.lastRestore).toBeUndefined()
  })
})

describe('the cross-repo contract', () => {
  /**
   * ⚠ The producer of this document lives in a DIFFERENT REPOSITORY — `lgr-deploy`'s
   * `scripts/verify-backups.sh`, which runs on mars. Nothing in this repo's type system
   * reaches it, so the only thing standing between a shell-side rename and a silently empty
   * Backups section is this fixture.
   *
   * `fixtures/backup-verify-report.json` is not hand-written: it is the literal output of
   * `verify-backups.sh --no-restore` against a healthy tree. Only `at` is rewritten, so the
   * report does not age into `stale` as the calendar moves.
   */
  it('parses the document verify-backups.sh actually emits', async () => {
    const real = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'fixtures', 'backup-verify-report.json'), 'utf8'),
    )
    writeFileSync(join(TMP, 'verify.json'), JSON.stringify({ ...real, at: hoursAgo(3) }))

    const b = await readBackupStatus()
    expect(b.healthy).toBe(true)
    expect(b.latestFull?.artifact).toBe('lgr-2026-09-03.archive.zst')
    expect(b.latestFull?.bytes).toBe(8_000_196)
    expect(b.generations).toEqual({ daily: 1, weekly: 1, monthly: 0, yearly: 0 })
    expect(b.delta?.slices).toBe(1)
    expect(b.uploads).toEqual({ snapshots: 1, files: 1, ageHours: 0 })
    expect(b.offsite?.reached).toEqual(['b2:lgr-backups', 'gjovanov@jupiter:/data/backup/lgr'])
    expect(b.checkCount).toBe(8)
    expect(b.failures).toEqual([])
    // `lastRestore: null` — a real report from a run that skipped the weekly restore test.
    expect(b.lastRestore).toBeUndefined()
  })

  it('renders that real report without losing a figure', async () => {
    const real = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'fixtures', 'backup-verify-report.json'), 'utf8'),
    )
    writeFileSync(join(TMP, 'verify.json'), JSON.stringify({ ...real, at: hoursAgo(3) }))
    const org = await orgWithBackups(true)
    const html = renderDigestHtml(await buildDailyDigest(String(org._id as Types.ObjectId), DAY))

    expect(html).toContain('lgr-2026-09-03.archive.zst')
    expect(html).toContain('7.6 MB')
    expect(html).toContain('1 daily · 1 weekly · 0 monthly · 0 yearly')
    expect(html).toContain('b2:lgr-backups')
    // The restore test never ran on this report — that must be visible, not omitted.
    expect(html).toContain('никога не е изпълняван')
  })
})

describe('the digest section (FR-13.6)', () => {
  it('is OFF by default — every other section defaults ON', async () => {
    writeReport()
    const org = await createTestOrg({ settings: { timezone: 'Europe/Sofia' } } as any)
    const d = await buildDailyDigest(String(org._id as Types.ObjectId), DAY)
    expect(d.backups).toBeUndefined()
    expect(d.kpis).toBeDefined()      // the contrast is the point
  })

  it('appears once the org opts in', async () => {
    writeReport()
    const org = await orgWithBackups(true)
    const d = await buildDailyDigest(String(org._id as Types.ObjectId), DAY)
    expect(isSectionError(d.backups)).toBe(false)
    expect((d.backups as any).healthy).toBe(true)
  })

  it('a healthy report does not disturb an otherwise clean day', async () => {
    writeReport()
    const org = await orgWithBackups(true)
    const d = await buildDailyDigest(String(org._id as Types.ObjectId), DAY)
    expect(d.allClear).toBe(true)
  })

  it('an unhealthy report takes the day OFF "all clear"', async () => {
    writeReport({ result: 'fail', detail: { failures: 1, checks: [{ check: 'uploads.count', result: 'fail', detail: 'snapshots: 0' }] } })
    const org = await orgWithBackups(true)
    const d = await buildDailyDigest(String(org._id as Types.ObjectId), DAY)
    expect((d.backups as any).healthy).toBe(false)
    expect(d.allClear).toBe(false)
  })

  it('a missing report also takes the day off "all clear"', async () => {
    const org = await orgWithBackups(true)
    const d = await buildDailyDigest(String(org._id as Types.ObjectId), DAY)
    expect((d.backups as any).gap).toBe('never_reported')
    expect(d.allClear).toBe(false)
  })
})

/**
 * The Layer-2 half of FR-13.6.
 *
 * ⚠ Everything above reads `verify.json`, which describes the CLUSTER's Layer-1 dumps on
 * mars. It says nothing about whether a given org's own per-org bundle ran — so before this,
 * an org's Layer-2 backup could fail every night indefinitely with a green Backups section
 * sitting above it. "A job writing to a log nobody reads is indistinguishable from no backup"
 * is the FR's own argument, and it applies to both layers.
 */
describe('the org’s own bundle in the digest (FR-13.6, Layer 2)', () => {
  const orgRunOf = (d: any) => (d.backups as any)?.orgRun

  it('reports a completed run beside the cluster-wide report', async () => {
    writeReport()
    const org = await orgWithBackups(true)
    const orgId = String(org._id as Types.ObjectId)
    await BackupRun.create({
      orgId, kind: 'full', date: DAY, status: 'completed',
      startedAt: new Date(), completedAt: new Date(),
      bytes: 3_300_000, documentCount: 95_090, sha256: 'a'.repeat(64),
    })

    const d = await buildDailyDigest(orgId, DAY)
    expect(orgRunOf(d).status).toBe('completed')
    expect(orgRunOf(d).documentCount).toBe(95_090)
    // Both layers green, so the day is still clear.
    expect(d.allClear).toBe(true)
  })

  it('a FAILED org bundle takes the day off "all clear" even when Layer 1 is green', async () => {
    writeReport()   // cluster-wide: everything passed
    const org = await orgWithBackups(true)
    const orgId = String(org._id as Types.ObjectId)
    await BackupRun.create({
      orgId, kind: 'full', date: DAY, status: 'failed', reason: 'disk full',
      startedAt: new Date(), completedAt: null, attempts: 3,
    })

    const d = await buildDailyDigest(orgId, DAY)
    expect((d.backups as any).healthy).toBe(true)      // Layer 1 really is fine
    expect(orgRunOf(d).status).toBe('failed')
    expect(orgRunOf(d).reason).toBe('disk full')
    // ⚠ The assertion that matters: a healthy Layer 1 must not launder a failed Layer 2.
    expect(d.allClear).toBe(false)
  })

  it('renders a failed org bundle as a visible failure naming the reason', async () => {
    writeReport()
    const org = await orgWithBackups(true)
    const orgId = String(org._id as Types.ObjectId)
    await BackupRun.create({
      orgId, kind: 'full', date: DAY, status: 'failed', reason: 'zstd unavailable',
      startedAt: new Date(), completedAt: null, attempts: 2,
    })

    const d = await buildDailyDigest(orgId, DAY)
    // ⚠ Rendered in the ORG's locale, not the caller's argument — `createTestOrg` defaults to
    // bg, which is what a regal-pz operator actually receives. Asserting the English string
    // here would pass only by accident of the fallback.
    const html = renderDigestHtml(d, d.locale)
    expect(html).toContain('АРХИВЪТ НА ТАЗИ ОРГАНИЗАЦИЯ НЕ УСПЯ')
    expect(html).toContain('zstd unavailable')
    expect(html).toContain('опит 2 от 3')
    // The red banner style, so this cannot pass as a quiet grey line.
    expect(html).toContain('#c62828')
  })

  it('says nothing at all when the org has never had a Layer-2 run', async () => {
    writeReport()
    const org = await orgWithBackups(true)
    const d = await buildDailyDigest(String(org._id as Types.ObjectId), DAY)
    // Absent, not a failure: the Layer-2 scheduler is opt-in and most orgs never enable it.
    expect(orgRunOf(d)).toBeUndefined()
    expect(d.allClear).toBe(true)
  })

  it('surfaces why the bundle was not emailed, without calling it a failure', async () => {
    writeReport()
    const org = await orgWithBackups(true)
    const orgId = String(org._id as Types.ObjectId)
    await BackupRun.create({
      orgId, kind: 'full', date: DAY, status: 'completed',
      startedAt: new Date(), completedAt: new Date(),
      bytes: 1234, documentCount: 5, emailed: true,
      emailSkippedReason: 'attachment_disabled_manifest_sent',
    })

    const d = await buildDailyDigest(orgId, DAY)
    expect(orgRunOf(d).emailSkippedReason).toBe('attachment_disabled_manifest_sent')
    expect(d.allClear).toBe(true)   // the artifact exists and verified; only the mail differed
    expect(renderDigestHtml(d, d.locale)).toContain('attachment_disabled_manifest_sent')
  })
})

describe('the digest section, rendered (FR-13.6)', () => {
  const render = async (on = true) => {
    const org = await orgWithBackups(on)
    return renderDigestHtml(await buildDailyDigest(String(org._id as Types.ObjectId), DAY))
  }

  it('renders the figures FR-13.6 asks for', async () => {
    writeReport()
    const html = await render()
    expect(html).toContain('Резервни копия')
    expect(html).toContain('lgr-2026-09-03.archive.zst')
    expect(html).toContain('3.2 MB')
    expect(html).toContain('14 daily · 8 weekly · 3 monthly · 0 yearly')
    expect(html).toContain('b2:lgr-backups')
    expect(html).toContain('107 collections')
  })

  it('renders a FAILURE as a visible failure, not as an absent section', async () => {
    writeReport({
      result: 'fail',
      detail: { failures: 1, checks: [{ check: 'uploads.count', result: 'fail', detail: 'total uploads snapshots: 0' }] },
    })
    const html = await render()
    expect(html).toContain('uploads.count')
    expect(html).toContain('total uploads snapshots: 0')
    expect(html).toContain('#c62828')          // the red banner/among the failure styling
  })

  it('says so loudly when no backup has ever been reported', async () => {
    const html = await render()
    expect(html).toContain('НИКОГА НЕ Е ДОКЛАДВАНО РЕЗЕРВНО КОПИЕ')
    expect(html).toContain('#c62828')
  })

  it('warns when the only copies are on one host', async () => {
    writeReport({ detail: { summary: { offsite: { reached: [], ageHours: 2 } } } })
    const html = await render()
    expect(html).toContain('няма копие извън обекта')
  })

  it('warns when the backups have never been proven restorable', async () => {
    writeReport({ detail: { lastRestore: null } })
    const html = await render()
    expect(html).toContain('никога не е изпълняван')
  })

  it('renders nothing at all when the org has not opted in', async () => {
    writeReport()
    const html = await render(false)
    expect(html).not.toContain('Резервни копия')
  })
})
