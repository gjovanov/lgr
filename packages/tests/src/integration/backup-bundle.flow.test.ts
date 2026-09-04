import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse,
  createTestUser,
} from '../helpers/factories'
import { config } from 'config'
import { AuditLog, BackupRun, Invoice } from 'db/models'
import {
  buildBundle, verifyBundle, readBundleManifest, tenantCollections, bundleDir, pruneBundles,
} from 'services/biz/backup/backup-bundle.service'
import {
  runBackupForOrg, backupTick, MAX_ATTACHMENT_BINARY_BYTES, STALE_CLAIM_MS,
} from 'services/biz/backup/backup-runner.service'
import { BUNDLE_FORMAT } from 'services/biz/backup/backup-bundle.types'
import type { Types } from 'mongoose'

/**
 * FR-13.10–13.19 (#24) — the per-org bundle, its lock, and its email pre-flight.
 *
 * NOTE: no `.rejects` / `.resolves` anywhere (Bun-on-Windows deadlock, see Known Issues) —
 * rejections are captured with try/catch.
 */

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-backup-'))
  config.upload.dir = TMP        // bundles land in a throwaway tree, as doc-store tests do
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => { await clearCollections() }, 30_000)

let TMP = ''
const DAY = '2026-09-03'

async function seedOrg() {
  const org = await createTestOrg({ slug: 'backup-co', settings: { timezone: 'Europe/Sofia' } } as any)
  const orgId = org._id as Types.ObjectId
  const customer = await createTestContact(orgId, { companyName: 'Buyer Ltd' })
  const wh = await createTestWarehouse(orgId, { name: 'Main' })
  await createTestProduct(orgId, { sku: 'BOLT-1', name: 'Болт М8Х25' })   // Cyrillic must survive
  await createTestProduct(orgId, { sku: 'NUT-1', name: 'Nut' })
  await createTestInvoice(orgId, customer._id as Types.ObjectId, {
    invoiceNumber: 'INV-2026-00010', type: 'invoice', direction: 'outgoing', status: 'paid',
    issueDate: new Date(`${DAY}T10:00:00.000Z`), total: 120,
  })
  return { org, orgId: String(orgId), wh }
}

/** The same org, opted in to the nightly scheduler. */
async function enabledOrg(opts: { slug?: string; hour?: number } = {}) {
  const org = await createTestOrg({
    slug: opts.slug || 'backup-co',
    settings: {
      timezone: 'Europe/Sofia',
      backup: { enabled: true, ...(opts.hour !== undefined ? { hour: opts.hour } : {}) },
    },
  } as any)
  return { org, orgId: String(org._id as Types.ObjectId) }
}

describe('the bundle (FR-13.12)', () => {
  it('discovers tenant collections instead of hardcoding a list', () => {
    const names = tenantCollections()
    expect(names).toContain('Invoice')
    expect(names).toContain('Product')
    expect(names).toContain('AuditLog')     // fiscal — FR-13.44 forbids ever losing it
    // Not org-scoped at all, so not in an org's bundle.
    expect(names).not.toContain('Org')
  })

  /**
   * ⚠ A restored `BackupRun` row with `status: 'running'` reads to the scheduler as a live
   * claim and SUPPRESSES the next backup until it goes stale. A backup able to stop the next
   * backup is the exact class of silent failure this FR exists to remove.
   */
  it('excludes the scheduler\'s own claims, which a restore would resurrect as live locks', async () => {
    expect(tenantCollections()).not.toContain('BackupRun')
    expect(tenantCollections()).not.toContain('DigestRun')

    const { orgId } = await seedOrg()
    await runBackupForOrg(orgId, DAY)                        // leaves a BackupRun row
    const built = await buildBundle(orgId, { date: '2026-09-04' })
    expect(built.manifest.collections.map(c => c.name)).not.toContain('BackupRun')
  })

  it('writes an artifact under <UPLOAD_DIR>/<orgId>/backups and hashes every section', async () => {
    const { orgId } = await seedOrg()
    const built = await buildBundle(orgId, { date: DAY })

    expect(built.absolutePath).toBe(join(bundleDir(orgId), built.filename))
    expect(built.filename).toContain('backup-co')
    expect(built.bytes).toBeGreaterThan(0)
    expect(built.sha256).toMatch(/^[0-9a-f]{64}$/)

    const m = built.manifest
    expect(m.format).toBe(BUNDLE_FORMAT)
    expect(m.orgSlug).toBe('backup-co')
    expect(m.documentCount).toBeGreaterThan(0)
    const invoices = m.collections.find(c => c.name === 'Invoice')!
    expect(invoices.count).toBe(1)
    expect(invoices.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(invoices.collection).toBe('invoices')
  })

  it('carries only the requesting org — a second org is not in the bundle', async () => {
    const { orgId } = await seedOrg()
    const other = await createTestOrg({ slug: 'other-co' } as any)
    const otherContact = await createTestContact(other._id as Types.ObjectId, { companyName: 'Someone Else' })
    await createTestInvoice(other._id as Types.ObjectId, otherContact._id as Types.ObjectId, {
      invoiceNumber: 'INV-OTHER-1', type: 'invoice', direction: 'outgoing', total: 999,
    })

    const built = await buildBundle(orgId, { date: DAY })
    const verified = await verifyBundle(built.absolutePath, built.sha256)
    expect(verified.ok).toBe(true)
    expect(built.manifest.collections.find(c => c.name === 'Invoice')!.count).toBe(1)

    // ⚠ Assert on the DECOMPRESSED BYTES, not just on the manifest count. The count only says
    // this org contributed one invoice; it would still pass if the other org's rows were also
    // in the artifact. The claim in the title is that the other org's data is ABSENT, and only
    // reading the payload can establish that.
    const plain = zstdDecompressSync(readFileSync(built.absolutePath)).toString('utf8')
    expect(plain).toContain('INV-2026-00010')
    expect(plain).not.toContain('INV-OTHER-1')
    expect(plain).not.toContain('Someone Else')
    expect(plain).not.toContain(String(other._id))
  })

  it('the manifest is reproducible from the bundle', async () => {
    const { orgId } = await seedOrg()
    const built = await buildBundle(orgId, { date: DAY })

    const verified = await verifyBundle(built.absolutePath, built.sha256)
    expect(verified.ok).toBe(true)
    expect(verified.problems).toEqual([])
    expect(verified.documentCount).toBe(built.manifest.documentCount)
    expect(verified.collections.every(c => c.shaOk && c.expected === c.found)).toBe(true)
  })

  it('round-trips Cyrillic', async () => {
    const { orgId } = await seedOrg()
    const built = await buildBundle(orgId, { date: DAY })
    const m = await readBundleManifest(built.absolutePath)
    expect(m.orgSlug).toBe('backup-co')
    const verified = await verifyBundle(built.absolutePath)
    // The section hash covers the raw NDJSON, so a mangled encoding would break it.
    expect(verified.collections.find(c => c.name === 'Product')!.shaOk).toBe(true)
  })

  it('rejects a one-byte-flipped artifact on the bundle checksum, before reading anything', async () => {
    const { orgId } = await seedOrg()
    const built = await buildBundle(orgId, { date: DAY })

    const raw = readFileSync(built.absolutePath)
    raw[Math.floor(raw.length / 2)] ^= 0xff
    writeFileSync(built.absolutePath, raw)

    const verified = await verifyBundle(built.absolutePath, built.sha256)
    expect(verified.ok).toBe(false)
    expect(verified.bundleShaOk).toBe(false)
    expect(verified.problems[0]).toContain('sha256')
    // Nothing else is claimed — a changed artifact is not evidence of anything.
    expect(verified.collections).toEqual([])
  })

  /**
   * ⚠ This is the FR-13.12 claim itself — "the manifest MUST be reproducible from the bundle
   * so a restore can prove completeness rather than assume it". Proving it requires a bundle
   * whose manifest LIES: a doctored header, re-compressed, with the artifact hash recomputed
   * so the cheap check passes and the expensive one has to catch it.
   *
   * (The previous version of this test deleted an invoice, rebuilt, and compared two honest
   * manifests. That asserts something about `buildBundle`, not about mismatch detection, and
   * would have passed with the verifier deleted entirely.)
   */
  it('catches a manifest that no longer matches its own sections', async () => {
    const { orgId } = await seedOrg()
    const built = await buildBundle(orgId, { date: DAY })

    const plain = zstdDecompressSync(readFileSync(built.absolutePath)).toString('utf8')
    const lines = plain.split('\n')
    const header = JSON.parse(lines[0])
    // Claim one more invoice than the bundle actually carries.
    const inv = header.manifest.collections.find((c: any) => c.name === 'Invoice')
    inv.count = inv.count + 1
    header.manifest.documentCount = header.manifest.documentCount + 1
    lines[0] = JSON.stringify(header)

    const doctored = zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
    writeFileSync(built.absolutePath, doctored)

    // Verified against the DOCTORED artifact's own hash, so the whole-bundle check passes and
    // the per-section re-count is the only thing that can catch this.
    const trueSha = createHash('sha256').update(doctored).digest('hex')
    const verified = await verifyBundle(built.absolutePath, trueSha)

    expect(verified.bundleShaOk).toBe(true)
    expect(verified.ok).toBe(false)
    expect(verified.problems.join(' ')).toContain('Invoice')
  })
})

describe('the claim (FR-13.11)', () => {
  it('records a completed run with its checksum and per-collection counts', async () => {
    const { orgId } = await seedOrg()
    const outcome = await runBackupForOrg(orgId, DAY)
    expect(outcome?.status).toBe('completed')

    const run: any = await BackupRun.findOne({ orgId, kind: 'full', date: DAY }).lean().exec()
    expect(run.status).toBe('completed')
    expect(run.sha256).toBe(outcome!.sha256)
    expect(run.documentCount).toBeGreaterThan(0)
    expect(run.collections.length).toBeGreaterThan(0)
    expect(run.completedAt).toBeTruthy()
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('the unique index IS the lock — a second runner takes no claim', async () => {
    const { orgId } = await seedOrg()
    const first = await runBackupForOrg(orgId, DAY)
    expect(first?.status).toBe('completed')

    const second = await runBackupForOrg(orgId, DAY)
    expect(second).toBeNull()
    expect(await BackupRun.countDocuments({ orgId, kind: 'full', date: DAY })).toBe(1)
  })

  it('separates kinds — full and delta are different claims for the same day', async () => {
    const { orgId } = await seedOrg()
    expect((await runBackupForOrg(orgId, DAY, { kind: 'full' }))?.status).toBe('completed')
    expect((await runBackupForOrg(orgId, DAY, { kind: 'delta' }))?.status).toBe('completed')
    expect(await BackupRun.countDocuments({ orgId, date: DAY })).toBe(2)
  })

  it('takes over a claim abandoned mid-build, but not a live one', async () => {
    const { orgId } = await seedOrg()
    await BackupRun.create({
      orgId, kind: 'full', date: DAY, status: 'running',
      startedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000),
    })
    const taken = await runBackupForOrg(orgId, DAY)
    expect(taken?.status).toBe('completed')

    await BackupRun.deleteMany({ orgId }).exec()
    await BackupRun.create({ orgId, kind: 'full', date: DAY, status: 'running', startedAt: new Date() })
    expect(await runBackupForOrg(orgId, DAY)).toBeNull()
  })

  it('a manual force run overwrites the day rather than being refused', async () => {
    const { orgId } = await seedOrg()
    await runBackupForOrg(orgId, DAY)
    // ⚠ A real USER id. The previous version passed a freshly created ORG's id as
    // `actorUserId`, which `createAuditEntry` casts to an ObjectId happily — so the test
    // proved nothing about the actor and the audit assertion below could never have been
    // written against it.
    const actor = await createTestUser(orgId as any, { email: 'forcer@backup.test' })
    const forced = await runBackupForOrg(orgId, DAY, {
      force: true, actorUserId: String(actor._id),
    })
    expect(forced?.status).toBe('completed')
    expect(await BackupRun.countDocuments({ orgId, kind: 'full', date: DAY })).toBe(1)

    // FR-13.25 — an operator's backup is an auditable act, and nothing tested that before.
    const audit: any = await AuditLog.findOne({
      orgId, entityType: 'backup', action: 'create',
    }).lean().exec()
    expect(audit).toBeTruthy()
    expect(String(audit.userId)).toBe(String(actor._id))
    expect(audit.module).toBe('admin')
    expect(audit.entityName).toBe(forced!.filename)
  })

  it('records a failure as a failure, with its reason', async () => {
    const orgId = '6a99000000000000000000ff'
    const outcome = await runBackupForOrg(orgId, DAY)
    expect(outcome?.status).toBe('failed')
    expect(outcome?.reason).toContain('not found')
    // Scoped to the org, not "whatever single row exists" — the previous version only worked
    // because the collection happened to be empty.
    const run: any = await BackupRun.findOne({ orgId, date: DAY }).lean().exec()
    expect(run.status).toBe('failed')
  })

  /**
   * ⚠ The most on-theme defect this PR fixes. A failed run used to set `completedAt`, which
   * `backupTick` reads as "done for today" and `claimDay`'s takeover requires to be null — so
   * one transient failure at 03:00 silently cost the org its entire night, leaving nothing but
   * a log line. That is the roomler failure mode reproduced inside the code written to
   * prevent it.
   */
  it('a failed run leaves the day retryable, and the retry succeeds', async () => {
    const { orgId } = await seedOrg()
    await BackupRun.create({
      orgId, kind: 'full', date: DAY, status: 'failed', reason: 'disk full',
      startedAt: new Date(), completedAt: null, attempts: 1,
    })

    const retried = await runBackupForOrg(orgId, DAY)
    expect(retried?.status).toBe('completed')

    const run: any = await BackupRun.findOne({ orgId, kind: 'full', date: DAY }).lean().exec()
    expect(run.status).toBe('completed')
    expect(run.attempts).toBe(2)
    expect(run.completedAt).toBeTruthy()
  })

  it('stops retrying once the attempt cap is reached', async () => {
    const { orgId } = await seedOrg()
    await BackupRun.create({
      orgId, kind: 'full', date: DAY, status: 'failed', reason: 'broken',
      startedAt: new Date(), completedAt: null, attempts: config.backup.maxAttemptsPerDay,
    })
    // Not "it failed again" — it is not attempted at all, so the recorded reason survives for
    // the digest to report instead of being overwritten every ten minutes.
    expect(await runBackupForOrg(orgId, DAY)).toBeNull()
    const run: any = await BackupRun.findOne({ orgId, date: DAY }).lean().exec()
    expect(run.reason).toBe('broken')
  })

  it('a failed run keeps completedAt null so the tick can pick it up again', async () => {
    const outcome = await runBackupForOrg('6a99000000000000000000ff', DAY)
    expect(outcome?.status).toBe('failed')
    const run: any = await BackupRun.findOne({ date: DAY }).lean().exec()
    expect(run.completedAt).toBeFalsy()
    expect(run.failedAt).toBeTruthy()
  })
})

/**
 * FR-13.12's date is a SECURITY boundary, not input tidiness: it reaches the artifact
 * filename, the filename is persisted on the run, and `/download` joins that stored value
 * back onto `bundleDir()` and streams it.
 */
describe('the date is a path component (FR-13.12)', () => {
  it('refuses a traversal disguised as a date', async () => {
    const { orgId } = await seedOrg()
    let message = ''
    try {
      await buildBundle(orgId, { date: '../../../../evil' })
    } catch (e: any) {
      message = e?.message || ''
    }
    expect(message).toContain('invalid backup date')

    // And nothing was written anywhere, under any name. A missing directory is the strongest
    // form of that: the guard fires before `mkdir`, so the org's backup tree is never created.
    let written: string[] = []
    try { written = readdirSync(bundleDir(orgId)) } catch { written = [] }
    expect(written).toEqual([])
  })

  it('accepts only YYYY-MM-DD', async () => {
    const { orgId } = await seedOrg()
    for (const bad of ['2026-9-3', '2026/09/03', '', 'today', '2026-09-03/../x']) {
      let threw = false
      try { await buildBundle(orgId, { date: bad }) } catch { threw = true }
      expect(threw).toBe(true)
    }
    const ok = await buildBundle(orgId, { date: '2026-09-03' })
    expect(ok.filename).toBe('lgr-backup-co-full-2026-09-03.ndjson.zst')
  })

  it('keeps the artifact inside the org bundle directory even for an odd slug', async () => {
    const org = await createTestOrg({ slug: '../../escape' } as any)
    const built = await buildBundle(String(org._id), { date: DAY })
    expect(built.filename).not.toContain('/')
    expect(built.filename).not.toContain('\\')
    expect(built.absolutePath.startsWith(bundleDir(String(org._id)))).toBe(true)
  })
})

describe('the scheduler (FR-13.10)', () => {
  const NOON = new Date('2026-09-03T12:00:00.000Z')   // well past hour 3, Europe/Sofia

  /**
   * ⚠ The gate is the whole reason this is safe to deploy. 73 of the 80 orgs in production
   * are `e2e-*` test tenants; an ungated scheduler would bundle every one of them nightly
   * onto the uploads PV — the tightest resource in the system.
   */
  it('ignores orgs that have not opted in', async () => {
    await seedOrg()                                   // enabled is not set
    const res = await backupTick(NOON)
    expect(res.checked).toBe(0)
    expect(res.ran).toBe(0)
    expect(await BackupRun.countDocuments({})).toBe(0)
  })

  it('runs an opted-in org whose hour has arrived, and skips it afterwards', async () => {
    const { orgId } = await enabledOrg()
    expect((await backupTick(NOON)).ran).toBe(1)
    expect((await backupTick(NOON)).ran).toBe(0)
    expect(await BackupRun.countDocuments({ orgId })).toBe(1)
  })

  it('does not run before the org-local hour', async () => {
    await enabledOrg()
    // 22:00 UTC = 01:00 Sofia the next day — before hour 3.
    expect((await backupTick(new Date('2026-09-03T22:00:00.000Z'))).ran).toBe(0)
  })

  it('honours a per-org hour override', async () => {
    await enabledOrg({ hour: 23 })
    // Sofia is UTC+3 in September: 12:00 UTC is 15:00 local, before 23:00.
    expect((await backupTick(NOON)).ran).toBe(0)
    // 20:00 UTC is 23:00 local — the hour has arrived.
    expect((await backupTick(new Date('2026-09-03T20:00:00.000Z'))).ran).toBe(1)
  })

  it('a manual run works for an org that has NOT opted in', async () => {
    // The gate is on the scheduler only — never on an admin backing up their own org.
    const { orgId } = await seedOrg()
    expect((await runBackupForOrg(orgId, DAY))?.status).toBe('completed')
  })

  it('one org does not stop the others', async () => {
    await enabledOrg()
    await enabledOrg({ slug: 'second-co' })
    const res = await backupTick(NOON)
    expect(res.checked).toBe(2)
    expect(res.ran).toBe(2)
  })
})

describe('retention (FR-13.8 applied to Layer 2)', () => {
  it('keeps N generations and removes the rest', async () => {
    const { orgId } = await seedOrg()
    for (const d of ['01', '02', '03', '04', '05']) {
      await buildBundle(orgId, { date: `2026-09-${d}` })
    }
    expect(readdirSync(bundleDir(orgId)).length).toBe(5)

    const removed = await pruneBundles(orgId, 'full', 3)
    expect(removed.length).toBe(2)
    const left = readdirSync(bundleDir(orgId)).sort()
    expect(left.length).toBe(3)
    // The NEWEST survive — retention counts generations, it does not pick arbitrarily.
    expect(left.some(f => f.includes('2026-09-05'))).toBe(true)
    expect(left.some(f => f.includes('2026-09-01'))).toBe(false)
  })

  /** The rule that makes this different from `find -mtime +N -delete`. */
  it('never deletes the last good bundle, however old it is', async () => {
    const { orgId } = await seedOrg()
    await buildBundle(orgId, { date: '2019-01-01' })
    expect(await pruneBundles(orgId, 'full', 14)).toEqual([])
    expect(readdirSync(bundleDir(orgId)).length).toBe(1)
    // Even asking to keep zero cannot empty the directory.
    expect(await pruneBundles(orgId, 'full', 0)).toEqual([])
    expect(readdirSync(bundleDir(orgId)).length).toBe(1)
  })

  it('prunes per kind — a run of deltas cannot evict the fulls', async () => {
    const { orgId } = await seedOrg()
    await buildBundle(orgId, { date: '2026-09-01', kind: 'full' })
    for (const d of ['01', '02', '03']) {
      await buildBundle(orgId, { date: `2026-09-${d}`, kind: 'delta' })
    }
    await pruneBundles(orgId, 'delta', 1)
    const left = readdirSync(bundleDir(orgId))
    expect(left.filter(f => f.includes('-full-')).length).toBe(1)
    expect(left.filter(f => f.includes('-delta-')).length).toBe(1)
  })

  it('a completed run prunes, and marks the rows whose artifact it removed', async () => {
    const { orgId } = await seedOrg()
    const saved = config.backup.keepPerOrg
    config.backup.keepPerOrg = 2
    try {
      for (const d of ['01', '02', '03']) {
        await runBackupForOrg(orgId, `2026-09-${d}`)
      }
      expect(readdirSync(bundleDir(orgId)).length).toBe(2)

      const pruned: any = await BackupRun.findOne({ orgId, date: '2026-09-01' }).lean().exec()
      expect(pruned.artifactPruned).toBe(true)
      // The row survives — it is the history and the audit trail.
      expect(pruned.status).toBe('completed')
      expect(pruned.sha256).toBeTruthy()

      const kept: any = await BackupRun.findOne({ orgId, date: '2026-09-03' }).lean().exec()
      expect(kept.artifactPruned).toBeUndefined()
    } finally {
      config.backup.keepPerOrg = saved
    }
  })
})

describe('the email ceiling (FR-13.18)', () => {
  it('is 14.6 MiB of binary, not the 20 MB constant', () => {
    // The cap in email.service.ts is applied to the BASE64 length, which inflates by 4/3.
    // Getting this wrong means the send is attempted and fails as an opaque provider_error.
    expect(MAX_ATTACHMENT_BINARY_BYTES).toBe(15_728_640)
    expect(MAX_ATTACHMENT_BINARY_BYTES / 1024 / 1024).toBeCloseTo(15, 0)
    expect(Math.ceil(MAX_ATTACHMENT_BINARY_BYTES / 3) * 4).toBeLessThanOrEqual(20 * 1024 * 1024)
  })

  it('skips the mail with a recorded reason when no recipient is configured', async () => {
    const { orgId } = await seedOrg()
    const outcome = await runBackupForOrg(orgId, DAY)
    expect(outcome?.emailed).toBe(false)
    expect(outcome?.emailSkippedReason).toBe('no_recipients')
    // The run itself still succeeded: email is a courier, not a copy (FR-13.19).
    expect(outcome?.status).toBe('completed')
  })
})
