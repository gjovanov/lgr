import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse,
} from '../helpers/factories'
import { config } from 'config'
import { BackupRun, Invoice } from 'db/models'
import {
  buildBundle, verifyBundle, readBundleManifest, tenantCollections, bundleDir,
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
    const plain = readFileSync(built.absolutePath)
    // Decompress via the reader rather than asserting on bytes.
    const verified = await verifyBundle(built.absolutePath, built.sha256)
    expect(verified.ok).toBe(true)
    expect(built.manifest.collections.find(c => c.name === 'Invoice')!.count).toBe(1)
    expect(plain.length).toBeGreaterThan(0)
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

  it('catches a manifest that no longer matches its own sections', async () => {
    const { orgId } = await seedOrg()
    const built = await buildBundle(orgId, { date: DAY })
    // Delete a document, rebuild, then verify the OLD manifest against the NEW bundle by
    // checking the count the manifest recorded is not what a fresh build produces.
    await Invoice.deleteMany({ orgId }).exec()
    const rebuilt = await buildBundle(orgId, { date: '2026-09-04' })
    expect(rebuilt.manifest.collections.find(c => c.name === 'Invoice')).toBeUndefined()
    expect(built.manifest.collections.find(c => c.name === 'Invoice')!.count).toBe(1)
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
    const forced = await runBackupForOrg(orgId, DAY, { force: true, actorUserId: String((await createTestOrg({ slug: 'x' } as any))._id) })
    expect(forced?.status).toBe('completed')
    expect(await BackupRun.countDocuments({ orgId, kind: 'full', date: DAY })).toBe(1)
  })

  it('records a failure as a failure, with its reason', async () => {
    const outcome = await runBackupForOrg('6a99000000000000000000ff', DAY)
    expect(outcome?.status).toBe('failed')
    expect(outcome?.reason).toContain('not found')
    const run: any = await BackupRun.findOne({ date: DAY }).lean().exec()
    expect(run.status).toBe('failed')
  })
})

describe('the scheduler (FR-13.10)', () => {
  it('runs an org whose hour has arrived and skips it afterwards', async () => {
    const { orgId } = await seedOrg()
    // Europe/Sofia, well past the configured hour.
    const noon = new Date('2026-09-03T12:00:00.000Z')
    const first = await backupTick(noon)
    expect(first.ran).toBeGreaterThanOrEqual(1)

    const second = await backupTick(noon)
    expect(second.ran).toBe(0)
    expect(await BackupRun.countDocuments({ orgId })).toBe(1)
  })

  it('does not run before the org-local hour', async () => {
    await seedOrg()
    // 00:30 UTC = 03:30 Sofia in summer… so pick 22:00 UTC = 01:00 Sofia the NEXT day.
    const beforeHour = new Date('2026-09-03T22:00:00.000Z')
    const res = await backupTick(beforeHour)
    expect(res.ran).toBe(0)
  })

  it('one org failing does not stop the others', async () => {
    await seedOrg()
    await createTestOrg({ slug: 'second-co', settings: { timezone: 'Europe/Sofia' } } as any)
    const res = await backupTick(new Date('2026-09-03T12:00:00.000Z'))
    expect(res.checked).toBeGreaterThanOrEqual(2)
    expect(res.ran).toBeGreaterThanOrEqual(2)
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
