import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { config } from 'config'
import { BackupRun } from 'db/models'
import { forgetAllHomes, homeNewOrg } from 'db/home/home'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { FILES_SIDECAR_FORMAT_ORG, restoreFilesSidecar } from 'services/biz/backup/backup-files.service'
import type { Types } from 'mongoose'

/**
 * FR-20.21 (plan step P1-9) — backups on a master: a local copy (a second disk, a USB drive, a NAS
 * path) of every night's bundle, and on a master the nightly run carries the org's WHOLE upload
 * tree, since nothing like mars's Layer-1 rsync backs a master's files up.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''
let LOCAL = ''
const saved = { role: config.node.role, id: (config.node as any).id, localPath: config.backup.localPath, localKeep: config.backup.localKeep }

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-backup-master-'))
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
  config.backup.localPath = saved.localPath
  config.backup.localKeep = saved.localKeep
  forgetAllHomes()
  await clearCollections()
}, 30_000)

async function seedOrg(slug: string, home = false) {
  const org = await createTestOrg({ slug, settings: { timezone: 'Europe/Sofia' } } as any)
  const orgId = org._id as Types.ObjectId
  // On a master, an org is written only once it is homed there (FR-20.18).
  if (home) await homeNewOrg(String(orgId))
  const customer = await createTestContact(orgId, { companyName: 'Buyer Ltd' })
  await createTestInvoice(orgId, customer._id as Types.ObjectId, {
    invoiceNumber: 'INV-2026-00010', type: 'invoice', direction: 'outgoing', status: 'paid',
    issueDate: new Date('2026-09-03T10:00:00.000Z'), total: 120,
  })
  return String(orgId)
}

function freshLocal(): string {
  LOCAL = mkdtempSync(join(TMP, 'usb-'))
  config.backup.localPath = LOCAL
  return LOCAL
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function sidecarLines(path: string): any[] {
  return zstdDecompressSync(readFileSync(path)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('the local copy (FR-20.21)', () => {
  it('is written, read back, and kept to its generations', async () => {
    const orgId = await seedOrg('usb-co')
    const local = freshLocal()
    config.backup.localKeep = 2
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      const outcome = await runBackupForOrg(orgId, day)
      expect(outcome?.status).toBe('completed')
    }
    const run: any = await BackupRun.findOne({ orgId, date: '2026-09-03' }).lean().exec()
    const copy = run.destinations.find((d: any) => d.name === 'local_path')
    expect(copy).toMatchObject({ status: 'reached', verified: true, filename: run.filename })

    const dir = join(local, 'LGR', 'Backups', 'usb-co', 'full')
    const names = readdirSync(dir).sort()
    // Two generations kept; the oldest pruned; no `.partial` left behind.
    expect(names.some(n => n.includes('2026-09-01'))).toBe(false)
    expect(names.some(n => n.includes('2026-09-02')) && names.some(n => n.includes('2026-09-03'))).toBe(true)
    expect(names.some(n => n.endsWith('.partial'))).toBe(false)
    // The copy IS the bundle, byte for byte.
    const bundle = readFileSync(join(config.upload.dir, orgId, 'backups', run.filename))
    expect(sha(readFileSync(join(dir, run.filename)))).toBe(sha(bundle))
  })

  it('a location that is not there is a failed destination, never a failed run, and is not created', async () => {
    const orgId = await seedOrg('unplugged-co')
    const missing = join(TMP, 'the-usb-drive-nobody-plugged-in')
    config.backup.localPath = missing
    const outcome = await runBackupForOrg(orgId, '2026-09-03')
    expect(outcome?.status).toBe('completed')
    const run: any = await BackupRun.findOne({ orgId, date: '2026-09-03' }).lean().exec()
    const copy = run.destinations.find((d: any) => d.name === 'local_path')
    expect(copy.status).toBe('failed')
    expect(copy.reason).toContain('is not there')
    expect(existsSync(missing)).toBe(false)
  })

  it('stays out of what else a person keeps in that folder', async () => {
    const orgId = await seedOrg('tidy-co')
    const local = freshLocal()
    config.backup.localKeep = 1
    const dir = join(local, 'LGR', 'Backups', 'tidy-co', 'full')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'the owner keeps this here')
    await runBackupForOrg(orgId, '2026-09-02')
    await runBackupForOrg(orgId, '2026-09-03')
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('the owner keeps this here')
  })
})

describe('on a master (FR-20.21)', () => {
  async function masterOrg(slug: string) {
    ;(config.node as any).role = 'master'
    ;(config.node as any).id = 'master-abcdefghijklmnop'
    forgetAllHomes()
    const orgId = await seedOrg(slug, true)
    // What the org has uploaded, beyond `docs/`: what a master's backup must carry.
    const root = join(config.upload.dir, orgId)
    mkdirSync(join(root, 'docs', '2026-09-03'), { recursive: true })
    mkdirSync(join(root, 'files'), { recursive: true })
    mkdirSync(join(root, 'backups'), { recursive: true })
    writeFileSync(join(root, 'docs', '2026-09-03', 'фактура-1.pdf'), '%PDF-1.7 invoice')
    writeFileSync(join(root, 'files', 'logo.png'), 'PNG logo bytes')
    writeFileSync(join(root, 'backups', 'lgr-old-full-2026-01-01.ndjson.zst'), 'an old bundle')
    return orgId
  }

  it('the nightly run carries the whole upload tree, and never the backups themselves', async () => {
    const orgId = await masterOrg('kasa-co')
    const local = freshLocal()
    const outcome = await runBackupForOrg(orgId, '2026-09-03')
    expect(outcome?.status).toBe('completed')
    const run: any = await BackupRun.findOne({ orgId, date: '2026-09-03' }).lean().exec()
    expect(run.variant).toBe('full')
    expect(run.filesFilename).toBeTruthy()

    const lines = sidecarLines(join(config.upload.dir, orgId, 'backups', run.filesFilename))
    expect(lines[0].format).toBe(FILES_SIDECAR_FORMAT_ORG)
    const paths = lines.slice(1).map(l => l.path).sort()
    expect(paths).toEqual(['docs/2026-09-03/фактура-1.pdf', 'files/logo.png'])

    // The local copy holds both artifacts.
    const dir = join(local, 'LGR', 'Backups', 'kasa-co', 'full')
    expect(readdirSync(dir).sort()).toEqual([run.filename, run.filesFilename].sort())
  })

  it('a run asked for as `data` stays `data`', async () => {
    const orgId = await masterOrg('data-co')
    const outcome = await runBackupForOrg(orgId, '2026-09-03', { variant: 'data' })
    expect(outcome?.status).toBe('completed')
    const run: any = await BackupRun.findOne({ orgId, date: '2026-09-03' }).lean().exec()
    expect(run.variant).toBe('data')
  })

  it('restores each file where it lived, and refuses the backups and anything outside the tree', async () => {
    const orgId = await masterOrg('restore-co')
    await runBackupForOrg(orgId, '2026-09-03')
    const run: any = await BackupRun.findOne({ orgId, date: '2026-09-03' }).lean().exec()
    const sidecar = join(config.upload.dir, orgId, 'backups', run.filesFilename)

    const target = '6a0000000000000000000099'
    const restored = await restoreFilesSidecar(sidecar, target)
    expect(restored.written).toBe(2)
    expect(readFileSync(join(config.upload.dir, target, 'files', 'logo.png'), 'utf8')).toBe('PNG logo bytes')
    expect(readFileSync(join(config.upload.dir, target, 'docs', '2026-09-03', 'фактура-1.pdf'), 'utf8')).toBe('%PDF-1.7 invoice')

    // A crafted one: a write into `backups/`, and a walk out of the tree.
    const entry = (path: string) => JSON.stringify({ path, size: 1, sha256: sha(Buffer.from('x')), b64: Buffer.from('x').toString('base64') })
    const crafted = join(TMP, 'crafted.files.ndjson.zst')
    writeFileSync(crafted, zstdCompressSync(Buffer.from([
      JSON.stringify({ format: FILES_SIDECAR_FORMAT_ORG, orgId, createdAt: new Date().toISOString() }),
      entry('backups/lgr-restore-co-full-2026-09-03.ndjson.zst'),
      entry('../escaped.txt'),
      entry('files/ok.txt'),
    ].join('\n') + '\n')))
    const r = await restoreFilesSidecar(crafted, target)
    expect(r.refused.sort()).toEqual(['../escaped.txt', 'backups/lgr-restore-co-full-2026-09-03.ndjson.zst'])
    expect(r.written).toBe(1)
    expect(existsSync(join(config.upload.dir, 'escaped.txt'))).toBe(false)
  })
})
