import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { config } from 'config'
import { BackupRun } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { backupBeforeUpdate } from 'services/biz/backup/pre-update-backup.service'
import type { Types } from 'mongoose'

/**
 * FR-20.20 (plan step P1-8d): "a backup first, then migrations, then a health check". Before the
 * update helper switches a master to a new version, the old version's API backs up every org homed
 * there, through its control socket. No backup, no switch.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''
const saved = { role: config.node.role, id: (config.node as any).id }

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-pre-update-'))
  config.upload.dir = join(TMP, 'uploads')
  mkdirSync(config.upload.dir, { recursive: true })
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  forgetAllHomes()
  await clearCollections()
}, 30_000)

async function seedOrg(slug: string, home: boolean) {
  const org = await createTestOrg({ slug, settings: { timezone: 'Europe/Sofia' } } as any)
  const orgId = org._id as Types.ObjectId
  // An org homed elsewhere: its row only. A master writes none of its data (the write guard).
  if (!home) return String(orgId)
  await homeNewOrg(String(orgId))
  const customer = await createTestContact(orgId, { companyName: 'Buyer Ltd' })
  await createTestInvoice(orgId, customer._id as Types.ObjectId, {
    invoiceNumber: 'INV-2026-00010', type: 'invoice', direction: 'outgoing', status: 'paid',
    issueDate: new Date('2026-10-20T10:00:00.000Z'), total: 120,
  })
  return String(orgId)
}

function asMaster() {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = 'master-preupdatetest00'
}

describe('the backup before an update (FR-20.20)', () => {
  it('backs up every org homed here, rows only, mailed to nobody, under a claim of its own', async () => {
    asMaster()
    const mine = await seedOrg('home-co', true)
    const other = await seedOrg('elsewhere-co', false)

    const result = await backupBeforeUpdate(new Date('2026-10-25T22:30:00.000Z'))
    expect(result.ok).toBe(true)
    expect(result.runs.map(r => r.orgId)).toEqual([mine])
    expect(result.runs[0].status).toBe('completed')
    expect(result.runs[0].filename).toContain('pre-update-')

    const rows = await BackupRun.find({}).lean().exec()
    expect(rows.map((r: any) => String(r.orgId))).toEqual([mine])
    const row: any = rows[0]
    expect(String(row.claimKey)).toMatch(/^pre-update-/)
    expect(row.variant).toBe('data')
    expect(row.emailed).toBe(false)
    expect(row.emailSkippedReason).toBe('not_mailed')
    expect(row.source).toBe('manual')
    // The org-local day: 22:30 UTC on the 25th is 00:30 on the 26th in Sofia (EET, summer time over).
    expect(row.date).toBe('2026-10-26')
    void other
  })

  it('takes nothing from the night: the scheduled run of the same day still runs', async () => {
    asMaster()
    const mine = await seedOrg('night-co', true)
    const before = await backupBeforeUpdate(new Date('2026-10-25T20:00:00.000Z'))
    expect(before.ok).toBe(true)
    const nightly = await runBackupForOrg(mine, '2026-10-25')
    expect(nightly?.status).toBe('completed')
    expect(nightly?.filename).not.toBe(before.runs[0].filename)
  })

  it('two updates are two backups, never one written over the other', async () => {
    asMaster()
    await seedOrg('twice-co', true)
    const a = await backupBeforeUpdate(new Date('2026-10-25T20:00:00.000Z'))
    const b = await backupBeforeUpdate(new Date('2026-10-25T20:00:05.000Z'))
    expect(a.ok && b.ok).toBe(true)
    expect(a.runs[0].filename).not.toBe(b.runs[0].filename)
    expect(await BackupRun.countDocuments({})).toBe(2)
  })

  it('with nothing homed here there is nothing to back up, and that is not a failure', async () => {
    asMaster()
    await seedOrg('not-here', false)
    const result = await backupBeforeUpdate()
    expect(result).toEqual({ ok: true, runs: [] })
    expect(existsSync(TMP)).toBe(true)
  })
})
