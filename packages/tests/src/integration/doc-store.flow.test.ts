import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { DocFile, AuditLog } from 'db/models'
import { config } from 'config'
import { storeDocument, storeDocuments, getVersions, listDocuments, parseDocMeta, batchDocDate } from 'services/biz/files/doc-store.service'
import { join } from 'path'
import { existsSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

let TMP: string
beforeAll(async () => {
  await setupTestDB()
  TMP = join(tmpdir(), `lgr-docstore-test-${Date.now()}`)
  config.upload.dir = TMP // override so the test writes into a throwaway dir
})
afterAll(async () => { await teardownTestDB(); try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ } })
afterEach(async () => { await clearCollections() })

/** A minimal File-like the store accepts ({ name, type, size, arrayBuffer }). */
function fakeFile(name: string, content: string, type = 'application/pdf') {
  const bytes = new TextEncoder().encode(content)
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Files — doc-store', () => {
  it('parseDocMeta classifies by filename; xlsx dates from the stamp, PDFs defer', () => {
    expect(parseDocMeta('invoicem_3000100691.pdf')).toEqual({ docType: 'invoice', docNumber: '3000100691', docDate: null })
    expect(parseDocMeta('stokrazp_3000016216.pdf')).toEqual({ docType: 'goods_receipt', docNumber: '3000016216', docDate: null })
    expect(parseDocMeta('sklrazp_0000012642.pdf')).toEqual({ docType: 'transfer_note', docNumber: '0000012642', docDate: null })
    expect(parseDocMeta('storeAvailability_20260826_195852.xlsx')).toEqual({ docType: 'store_availability', docNumber: '20260826_195852', docDate: '2026-08-26' })
    expect(parseDocMeta('salesAnalysis_20260813_172956.xlsx')).toEqual({ docType: 'cash_register', docNumber: '20260813_172956', docDate: '2026-08-13' })
  })


  it('treats a downloaded copy as the SAME document, not a new number', () => {
    // "invoicem_3000100975_1.pdf" is what a second download of the same export is called. Stripping
    // non-digits made it 30001009751 — a document that does not exist — with its own DocFile row, so
    // the byte-identical original was never recognised and the day carried a phantom extra invoice.
    expect(parseDocMeta('invoicem_3000100975_1.pdf').docNumber).toBe('3000100975')
    expect(parseDocMeta('invoicem_3000100975 (1).pdf').docNumber).toBe('3000100975')
    expect(parseDocMeta('sklrazp_0000012710-2.pdf').docNumber).toBe('0000012710')
    // …while a real number is untouched, including one that ends in a digit run
    expect(parseDocMeta('invoicem_3000100975.pdf').docNumber).toBe('3000100975')
    expect(parseDocMeta('sklrazp_0000012710.pdf').docNumber).toBe('0000012710')
    expect(parseDocMeta('stokrazp_3000016359.pdf').docNumber).toBe('3000016359')
  })

  it('stores a new PDF in inbox, creates a DocFile v1, writes an upload audit', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const r = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016216.pdf', 'v1-content'))

    expect(r.isNew).toBe(true)
    expect(r.duplicate).toBe(false)
    expect(r.docFile.docType).toBe('goods_receipt')
    expect(r.docFile.docNumber).toBe('3000016216')
    expect(r.docFile.docDate).toBe('inbox')
    expect(r.docFile.version).toBe(1)
    // FR-20.24: stored relative to the upload root.
    expect(r.docFile.currentPath).toBe(`${org._id}/docs/inbox/stokrazp_3000016216.pdf`)
    expect(existsSync(join(TMP, ...r.docFile.currentPath.split('/')))).toBe(true)

    await sleep(60)
    const audits = await AuditLog.find({ orgId: org._id, module: 'files', action: 'upload' })
    expect(audits.length).toBe(1)
    expect(audits[0].entityName).toBe('stokrazp_3000016216.pdf')
  })

  it('files an xlsx into its date folder immediately', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const r = await storeDocument(String(org._id), String(user._id), fakeFile('storeAvailability_20260826_195852.xlsx', 'snap', 'application/vnd.ms-excel'))
    expect(r.docFile.docType).toBe('store_availability')
    expect(r.docFile.docDate).toBe('2026-08-26')
    expect(r.docFile.currentPath).toBe(`${org._id}/docs/2026-08-26/storeAvailability_20260826_195852.xlsx`)
  })

  it('re-upload with NEW content versions the prior copy (v2) and audits an overwrite', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const first = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016216.pdf', 'v1-content'))
    const firstPath = join(TMP, ...first.docFile.currentPath.split('/'))
    const second = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016216.pdf', 'v2-DIFFERENT'))

    expect(second.isNew).toBe(false)
    expect(second.duplicate).toBe(false)
    expect(second.replacedVersion).toBe(1)
    expect(second.docFile.version).toBe(2)
    // one canonical DocFile (idempotent key), not two
    expect(await DocFile.countDocuments({ orgId: org._id, docType: 'goods_receipt', docNumber: '3000016216' })).toBe(1)
    // the prior bytes were archived under versions/
    const vdir = join(TMP, String(org._id), 'docs', 'inbox', 'versions')
    expect(existsSync(vdir)).toBe(true)
    expect(readdirSync(vdir).some((f) => f.startsWith('stokrazp_3000016216_'))).toBe(true)
    // the canonical path now holds the new bytes
    expect(await Bun.file(firstPath).text()).toBe('v2-DIFFERENT')

    await sleep(60)
    expect(await AuditLog.countDocuments({ orgId: org._id, module: 'files', action: 'overwrite' })).toBe(1)

    const versions = await getVersions(String(org._id), String(second.docFile._id))
    expect(versions.current?.version).toBe(2)
    expect(versions.versions.length).toBe(1)
  })

  it('identical re-upload (same checksum) is a no-op', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    await storeDocument(String(org._id), String(user._id), fakeFile('sklrazp_0000012642.pdf', 'same-bytes'))
    const again = await storeDocument(String(org._id), String(user._id), fakeFile('sklrazp_0000012642.pdf', 'same-bytes'))

    expect(again.duplicate).toBe(true)
    expect(again.docFile.version).toBe(1) // unchanged
    const list = await listDocuments(String(org._id), { docType: 'transfer_note' })
    expect(list.total).toBe(1)
  })
})

describe('Files — a re-upload that CHANGED, versus one that did not', () => {
  /** Put a document in the state a committed import leaves behind. */
  async function commitLike(orgId: string, docFileId: any, checksum: string, version: number) {
    await DocFile.updateOne({ _id: docFileId }, {
      $set: {
        status: 'committed', committedTarget: 'movement', committedIds: [docFileId],
        markers: ['stokrazp:3000016311'], extractedText: 'OLD TEXT — ПОП-НИТ 4х20',
        analysis: { target: 'movement', mapped: { lines: [{ description: 'ПОП-НИТ 4х20' }] } },
        committedChecksum: checksum, committedVersion: version,
      },
    })
  }

  it('an identical re-upload is a duplicate and changes nothing', async () => {
    const org = await createTestOrg(); const user = await createTestUser(org._id)
    const a = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016311.pdf', 'same-bytes'))
    await commitLike(String(org._id), a.docFile._id, a.docFile.currentChecksum, a.docFile.version)

    const b = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016311.pdf', 'same-bytes'))
    expect(b.duplicate).toBe(true)
    expect(b.updated).toBe(false)
    expect(b.staleBooking).toBe(false)          // booked from exactly these bytes
    const after: any = await DocFile.findById(a.docFile._id).lean()
    expect(after.version).toBe(1)
    expect(after.extractedText).toBe('OLD TEXT — ПОП-НИТ 4х20')   // untouched
  })

  it('a CHANGED re-upload is an update, drops the stale extraction, and flags the booking', async () => {
    const org = await createTestOrg(); const user = await createTestUser(org._id)
    const a = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016311.pdf', 'v1-lines'))
    await commitLike(String(org._id), a.docFile._id, a.docFile.currentChecksum, a.docFile.version)

    const b = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016311.pdf', 'v2-lines-renamed'))
    expect(b.duplicate).toBe(false)
    expect(b.updated).toBe(true)
    expect(b.staleBooking).toBe(true)

    const after: any = await DocFile.findById(a.docFile._id).lean()
    expect(after.version).toBe(2)
    // The whole bug: these described the OLD bytes, and buildAnalyzeItem reuses extractedText
    // whenever it is set — so the correction re-analyzed to exactly what it said before.
    expect(after.extractedText).toBeUndefined()
    expect(after.analysis).toBeUndefined()
    // …while what it BOOKED is kept, because that is what a reconcile diffs against.
    expect(after.committedIds).toHaveLength(1)
    expect(after.markers).toEqual(['stokrazp:3000016311'])
  })

  it('the list marks the stale booking, so a corrected doc does not look finished', async () => {
    const org = await createTestOrg(); const user = await createTestUser(org._id)
    const a = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016311.pdf', 'v1'))
    await commitLike(String(org._id), a.docFile._id, a.docFile.currentChecksum, a.docFile.version)
    await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016311.pdf', 'v2'))

    const { docFiles } = await listDocuments(String(org._id), {})
    const row: any = docFiles.find((d: any) => d.docNumber === '3000016311')
    expect(row.staleBooking).toBe(true)
  })

  it('a booking made before committedChecksum existed still reports as stale at v2', async () => {
    const org = await createTestOrg(); const user = await createTestUser(org._id)
    const a = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016311.pdf', 'v1'))
    // legacy row: booked, but nothing records WHICH bytes (this is 3000016311 on production)
    await DocFile.updateOne({ _id: a.docFile._id }, {
      $set: { status: 'committed', committedTarget: 'movement', committedIds: [a.docFile._id], version: 2 },
      $unset: { committedChecksum: '', committedVersion: '' },
    })
    const { docFiles } = await listDocuments(String(org._id), {})
    expect((docFiles.find((d: any) => d.docNumber === '3000016311') as any).staleBooking).toBe(true)
  })
})

describe('Files — a batch names its own day', () => {
  /**
   * 2026-09-14's 45 PDFs all landed in `inbox` because the (optional) date box was left empty:
   * a PlusMinus PDF carries no date in its filename, while the spreadsheets uploaded beside it do.
   */
  it('reads the day from the dated spreadsheets in the same batch', () => {
    expect(batchDocDate([
      { name: 'invoicem_3000101043.pdf' },
      { name: 'stokrazp_3000016385.pdf' },
      { name: 'storeAvailability_20260914_223839.xlsx' },
      { name: 'salesAnalysis_20260914_223813.xlsx' },
    ])).toBe('2026-09-14')
  })

  it('refuses to guess when the batch spans days, or carries no dated file at all', () => {
    expect(batchDocDate([
      { name: 'storeAvailability_20260914_223839.xlsx' },
      { name: 'salesAnalysis_20260913_101010.xlsx' },
    ])).toBeUndefined()
    expect(batchDocDate([{ name: 'invoicem_3000101043.pdf' }])).toBeUndefined()
    expect(batchDocDate([])).toBeUndefined()
  })

  it('files an undated PDF under the batch day instead of inbox', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const results = await storeDocuments(String(org._id), String(user._id), [
      new File([new Uint8Array([1, 2, 3])], 'invoicem_3000101043.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([4, 5, 6])], 'storeAvailability_20260914_223839.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    ] as any)
    const pdf = results.find(r => r.name.endsWith('.pdf'))!
    expect(pdf.docFile.docDate).toBe('2026-09-14')
    expect(pdf.docFile.currentPath).toContain('2026-09-14')
    expect(pdf.docFile.currentPath).not.toContain('inbox')
  })

  it('still honours an explicit date over the one the batch names', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const [pdf] = await storeDocuments(String(org._id), String(user._id), [
      new File([new Uint8Array([7, 8, 9])], 'invoicem_3000101044.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([1])], 'storeAvailability_20260914_223839.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    ] as any, { docDate: '2026-09-13' })
    expect(pdf.docFile.docDate).toBe('2026-09-13')
  })
})
