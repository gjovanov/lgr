import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestFiscalYear } from '../helpers/factories'
import { config } from 'config'
import { ArchiveUnit, DocFile, FiscalYear } from 'db/models'
import {
  archivableYears, archiveFiscalYear, rehydrateDocFile, unarchiveUnit, orgArchiveDir, orgDocsDir,
} from 'services/biz/archive/archive.service'
import { resolveDownload } from 'services/biz/files/doc-store.service'
import type { Types } from 'mongoose'

/**
 * FR-13.38–13.42 (#24) — archiving document bytes.
 *
 * The thing under test is not "does it make a smaller file". It is: **can this ever lose a
 * document?** Приложение 29 т. 16 requires archived data to stay reachable „през
 * потребителски интерфейс", and ЗСч чл. 12 requires it to still be there in ten years. Every
 * assertion about verification order below is guarding the one failure that cannot be
 * recovered from — deleting loose files on the strength of an artifact nobody read back.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-archive-'))
  config.upload.dir = TMP
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => { await clearCollections() })

const NOW = new Date('2026-09-11T12:00:00.000Z')

/** A locked fiscal year comfortably past the 2-year horizon. */
async function lockedYear(orgId: Types.ObjectId, year = 2022) {
  return createTestFiscalYear(orgId, {
    name: String(year),
    startDate: new Date(`${year}-01-01T00:00:00.000Z`),
    endDate: new Date(`${year}-12-31T00:00:00.000Z`),
    status: 'locked',
  } as any)
}

/** A DocFile with real bytes on the PV, inside `year`. */
async function docWithBytes(orgId: Types.ObjectId, userId: Types.ObjectId, opts: {
  docDate: string
  name: string
  content: string
}) {
  const dir = join(orgDocsDir(String(orgId)), opts.docDate)
  mkdirSync(dir, { recursive: true })
  const abs = join(dir, opts.name)
  writeFileSync(abs, opts.content)
  const sha = createHash('sha256').update(Buffer.from(opts.content)).digest('hex')
  return DocFile.create({
    orgId, docType: 'invoice', docNumber: `INV-${opts.name}`, docDate: opts.docDate,
    originalName: opts.name, currentPath: abs, currentChecksum: sha,
    mimeType: 'application/pdf', size: Buffer.byteLength(opts.content),
    uploadedBy: userId, status: 'committed',
  } as any)
}

describe('choosing what may be archived (FR-13.38)', () => {
  it('offers a locked year past the horizon', async () => {
    const org = await createTestOrg()
    await lockedYear(org._id as Types.ObjectId, 2022)

    const years = await archivableYears(String(org._id), NOW)
    expect(years).toHaveLength(1)
    expect(years[0].name).toBe('2022')
    expect(years[0].coversFrom).toBe('2022-01-01')
  })

  it('refuses a year that is merely old but not locked', async () => {
    const org = await createTestOrg()
    // ⚠ Age is not the unit. An `open` or `closed` year may still be corrected, and packing
    // its documents away would cold-store a year somebody is actively working in.
    await createTestFiscalYear(org._id as Types.ObjectId, {
      name: '2021', startDate: new Date('2021-01-01'), endDate: new Date('2021-12-31'), status: 'closed',
    } as any)
    expect(await archivableYears(String(org._id), NOW)).toHaveLength(0)
  })

  it('refuses a locked year inside the horizon', async () => {
    const org = await createTestOrg()
    // Locked, but ended last year — `horizonYears: 2` is the grace on top of `locked`, so a
    // year locked early is not cold-stored while it is still being opened weekly.
    await lockedYear(org._id as Types.ObjectId, 2025)
    expect(await archivableYears(String(org._id), NOW)).toHaveLength(0)
  })

  it('refuses to pack a year that is not locked', async () => {
    const org = await createTestOrg()
    const fy = await createTestFiscalYear(org._id as Types.ObjectId, {
      name: '2021', startDate: new Date('2021-01-01'), endDate: new Date('2021-12-31'), status: 'open',
    } as any)
    let threw = ''
    try { await archiveFiscalYear(String(org._id), String(fy._id)) } catch (e: any) { threw = e.message }
    expect(threw).toContain('not locked')
  })
})

describe('packing a unit (FR-13.39)', () => {
  it('packs the year, marks the rows, and removes the loose files', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)

    const a = await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })
    const b = await docWithBytes(orgId, user._id as any, { docDate: '2022-11-30', name: 'b.pdf', content: 'BBBB' })

    const out = await archiveFiscalYear(String(orgId), String(fy._id))
    expect(out.status).toBe('packed')
    expect(out.fileCount).toBe(2)
    expect(out.checksumFailures).toEqual([])

    // The artifact exists and the loose bytes are gone.
    const unit: any = await ArchiveUnit.findById(out.unitId).lean().exec()
    expect(existsSync(join(orgArchiveDir(String(orgId)), unit.filename))).toBe(true)
    expect(existsSync((a as any).currentPath)).toBe(false)
    expect(existsSync((b as any).currentPath)).toBe(false)

    // ⚠ The ROWS stay live and listed. Приложение 29 т. 16 requires archived data to remain
    // reachable through the interface; a row that disappeared would satisfy neither the
    // ordinance nor the auditor who goes looking for the invoice.
    expect(await DocFile.countDocuments({ orgId })).toBe(2)
    const rowA: any = await DocFile.findById(a._id).lean().exec()
    expect(rowA.archived).toBe(true)
    expect(String(rowA.archiveRef)).toBe(out.unitId)
    expect(rowA.currentChecksum).toBeTruthy()
  })

  it('leaves documents outside the year alone', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId, 2022)

    await docWithBytes(orgId, user._id as any, { docDate: '2022-06-01', name: 'in.pdf', content: 'IN' })
    const outside = await docWithBytes(orgId, user._id as any, { docDate: '2024-06-01', name: 'out.pdf', content: 'OUT' })

    const out = await archiveFiscalYear(String(orgId), String(fy._id))
    expect(out.fileCount).toBe(1)
    expect(existsSync((outside as any).currentPath)).toBe(true)
    expect((await DocFile.findById(outside._id).lean().exec() as any).archived).toBeFalsy()
  })

  it('records a document whose bytes are already gone instead of claiming it', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)

    const ghost = await DocFile.create({
      orgId, docType: 'invoice', docNumber: 'INV-ghost', docDate: '2022-05-05',
      originalName: 'ghost.pdf', currentPath: join(orgDocsDir(String(orgId)), '2022-05-05', 'ghost.pdf'),
      currentChecksum: 'f'.repeat(64), mimeType: 'application/pdf', size: 10,
      uploadedBy: user._id, status: 'committed',
    } as any)

    const out = await archiveFiscalYear(String(orgId), String(fy._id))
    expect(out.missing).toHaveLength(1)
    // ⚠ NOT marked archived. A row claiming bytes that were never packed is worse than the
    // dangling row it already was — the next rehydrate would fail with "not in its unit"
    // instead of the honest "this file was already missing".
    expect((await DocFile.findById(ghost._id).lean().exec() as any).archived).toBeFalsy()
  })

  it('is claimed once per fiscal year', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })

    await archiveFiscalYear(String(orgId), String(fy._id))
    // ⚠ The unique index IS the lock, as with `BackupRun`. Two packers on one year would each
    // delete the loose files the other is still reading.
    let threw = ''
    try { await archiveFiscalYear(String(orgId), String(fy._id)) } catch (e: any) { threw = e.message }
    expect(threw).toContain('already archived')
    expect(await ArchiveUnit.countDocuments({ orgId })).toBe(1)
  })

  it('deletes nothing when a file disagrees with the checksum on its row', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    const good = await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })
    const bad = await docWithBytes(orgId, user._id as any, { docDate: '2022-06-06', name: 'b.pdf', content: 'BBB' })

    // ⚠ The row now describes bytes that are not on the PV — bit rot, a partial upload, an
    // out-of-band edit. Archiving is the worst possible moment to discover that quietly,
    // because the next step deletes the only loose copy.
    await DocFile.updateOne({ _id: bad._id }, { $set: { currentChecksum: 'f'.repeat(64) } }).exec()

    const out = await archiveFiscalYear(String(orgId), String(fy._id))
    expect(out.status).toBe('failed')
    expect(out.checksumFailures).toHaveLength(1)
    expect(out.reason).toContain('no files were removed')

    // ⚠ NOTHING was deleted — not even the file that verified cleanly. A partial archive is
    // the state nobody can reason about later, and the whole year is cheap to re-pack once a
    // human has looked at the one document that disagreed.
    expect(existsSync((good as any).currentPath)).toBe(true)
    expect(existsSync((bad as any).currentPath)).toBe(true)
    expect(await DocFile.countDocuments({ orgId, archived: true })).toBe(0)

    const unit: any = await ArchiveUnit.findById(out.unitId).lean().exec()
    expect(unit.status).toBe('failed')
    expect(unit.reason).toContain('verification')
  })

  it('a packed unit reproduces every byte it was given', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    // Cyrillic and a non-trivial payload: the container is base64 inside JSON inside zstd,
    // and every one of those layers has an encoding assumption in it.
    const body = 'Фактура №1234 — АБВ ' + 'x'.repeat(5000)
    const doc = await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'фактура.pdf', content: body })

    const out = await archiveFiscalYear(String(orgId), String(fy._id))
    expect(out.status).toBe('packed')

    const back = await rehydrateDocFile(String(orgId), String(doc._id))
    expect(back?.rehydrated).toBe(true)
    expect(readFileSync((doc as any).currentPath, 'utf8')).toBe(body)
  })
})

describe('rehydrating (FR-13.41/13.42)', () => {
  it('puts one document back without unpacking the year', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    const a = await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })
    const b = await docWithBytes(orgId, user._id as any, { docDate: '2022-11-30', name: 'b.pdf', content: 'BBBB' })
    await archiveFiscalYear(String(orgId), String(fy._id))

    const got = await rehydrateDocFile(String(orgId), String(a._id))
    expect(got?.rehydrated).toBe(true)
    expect(readFileSync((a as any).currentPath, 'utf8')).toBe('AAA')
    // ⚠ ONE member. The whole point of a line format over tar: rehydrating an invoice out of
    // a year streams until it finds it and stops, instead of unpacking hundreds of MB.
    expect(existsSync((b as any).currentPath)).toBe(false)
  })

  it('is what a download sees, with no caller-side knowledge of archiving', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    const a = await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })
    await archiveFiscalYear(String(orgId), String(fy._id))
    expect(existsSync((a as any).currentPath)).toBe(false)

    // ⚠ The route does nothing special. An archive the download path has to know about is one
    // a future route will forget about, and the symptom is a 404 on a document still listed.
    const dl = await resolveDownload(String(orgId), String(a._id))
    expect(dl).toBeTruthy()
    expect(existsSync(dl!.path)).toBe(true)
    expect(readFileSync(dl!.path, 'utf8')).toBe('AAA')
    expect(dl!.name).toBe('a.pdf')
  })

  it('is idempotent and cheap when the file is already there', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    const a = await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })
    await archiveFiscalYear(String(orgId), String(fy._id))

    await rehydrateDocFile(String(orgId), String(a._id))
    const second = await rehydrateDocFile(String(orgId), String(a._id))
    // A crash between "mark archived" and "unlink" leaves exactly this state, and it must
    // cost nothing.
    expect(second?.rehydrated).toBe(false)
  })

  it('passes a non-archived document straight through', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const a = await docWithBytes(orgId, user._id as any, { docDate: '2024-03-04', name: 'live.pdf', content: 'LIVE' })

    const got = await rehydrateDocFile(String(orgId), String(a._id))
    expect(got?.rehydrated).toBe(false)
    expect(readFileSync(got!.path, 'utf8')).toBe('LIVE')
  })
})

describe('un-archiving', () => {
  it('restores every file and clears the flags', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    const a = await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })
    const b = await docWithBytes(orgId, user._id as any, { docDate: '2022-11-30', name: 'b.pdf', content: 'BBBB' })
    const out = await archiveFiscalYear(String(orgId), String(fy._id))

    const res = await unarchiveUnit(String(orgId), out.unitId)
    expect(res.restored).toBe(2)
    expect(res.failures).toEqual([])
    expect(readFileSync((a as any).currentPath, 'utf8')).toBe('AAA')
    expect(readFileSync((b as any).currentPath, 'utf8')).toBe('BBBB')
    expect(await DocFile.countDocuments({ orgId, archived: true })).toBe(0)
  })

  it('keeps the artifact afterwards', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const user = await createTestUser(orgId)
    const fy = await lockedYear(orgId)
    await docWithBytes(orgId, user._id as any, { docDate: '2022-03-04', name: 'a.pdf', content: 'AAA' })
    const out = await archiveFiscalYear(String(orgId), String(fy._id))
    await unarchiveUnit(String(orgId), out.unitId)

    // ⚠ Deleting it would make the un-archive the only copy of an operation that has just
    // rewritten every file in a year, with no way back if the PV write was wrong.
    const unit: any = await ArchiveUnit.findById(out.unitId).lean().exec()
    expect(existsSync(join(orgArchiveDir(String(orgId)), unit.filename))).toBe(true)
  })
})
