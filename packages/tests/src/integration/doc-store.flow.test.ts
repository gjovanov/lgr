import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { DocFile, AuditLog } from 'db/models'
import { config } from 'config'
import { storeDocument, getVersions, listDocuments, parseDocMeta } from 'services/biz/files/doc-store.service'
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
    expect(existsSync(r.docFile.currentPath)).toBe(true)
    expect(r.docFile.currentPath).toBe(join(TMP, String(org._id), 'docs', 'inbox', 'stokrazp_3000016216.pdf'))

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
    expect(r.docFile.currentPath).toBe(join(TMP, String(org._id), 'docs', '2026-08-26', 'storeAvailability_20260826_195852.xlsx'))
  })

  it('re-upload with NEW content versions the prior copy (v2) and audits an overwrite', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const first = await storeDocument(String(org._id), String(user._id), fakeFile('stokrazp_3000016216.pdf', 'v1-content'))
    const firstPath = first.docFile.currentPath
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
