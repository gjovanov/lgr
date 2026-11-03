import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { AuditLog, File as FileModel, TaxReturn, VatRegisterEntry } from 'db/models'
import { VatReturnRefused, applyVatImport, planVatImport } from 'services/biz/vat-files/vat-return.service'
import { generateMonthFiles, readFiledMonth, type VatFile } from 'services/biz/vat-files/month'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * FR-25 R2 over HTTP: rows go in, the files come out byte for byte, a person files them, and the return
 * freezes. Everything made up: the golden files under `fixtures/vat-files`.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'vat-files')
const FILED = '202605'
const NIL = '202606'
const VAT_ID = 'BG999999999'

const monthFiles = (period: string): VatFile[] => {
  const dir = join(FIXTURES, period, '999999999')
  return readdirSync(dir).map(name => ({ name, bytes: new Uint8Array(readFileSync(join(dir, name))) }))
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** The month with its last sale gone from the register, and DEKLAR left as it was. */
const lessTheLastSale = (): VatFile[] => monthFiles(FILED).map(f => (f.name === 'PRODAGBI.txt' ? { ...f, bytes: f.bytes.slice(0, -426) } : f))

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let app: Elysia
let org: any
let orgId: string
let otherOrg: any
const tokens: Record<string, string> = {}

async function tokenFor(o: any, role: keyof typeof DEFAULT_ROLE_PERMISSIONS, tag = ''): Promise<string> {
  const email = `${role}${tag}@${o.slug}.test`
  const user = await createTestUser(o._id, { role, email } as any)
  return (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(o._id), role, email, username: role, firstName: 'V', lastName: 'R',
    permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
  })
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/accounting${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  }))
  const raw = new Uint8Array(await res.clone().arrayBuffer())
  let json: any = null
  try { json = await res.json() } catch { /* the bytes of a file */ }
  return { status: res.status, json, raw, headers: res.headers }
}

const importMonth = async (period: string, o: any = org) => {
  const plan = await planVatImport(o, monthFiles(period))
  await applyVatImport(String(o._id), plan)
  return plan
}

/** Rows that wait for a return: what the posting worker will leave (R3), unnumbered. */
async function openRows(period: string) {
  const row = (side: 'sales' | 'purchase', docNumber: string, day: number, cells: Record<string, number>, partnerVat = 'BG111111111') => ({
    orgId, period, side, ledger: 'books', rowNo: 0, docTypeCode: '01', docNumber, docDate: new Date(Date.UTC(2026, 6, day)),
    partnerVat, partnerName: 'ТЕСТОВ КЛИЕНТ ЕООД', description: 'Стоки', cells, frozen: false,
  })
  await VatRegisterEntry.insertMany([
    row('sales', '0000000202', 20, { '02-11': 20000, '02-21': 4000 }),
    row('sales', '0000000201', 10, { '02-11': 10000, '02-21': 2000 }),
    row('purchase', '1000000301', 15, { '03-31': 5000, '03-41': 1000 }, 'BG222222222'),
  ])
}
const OPEN = '202607'
const SET_FILER = { filer: 'ИВАН ПРИМЕРОВ' }

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  org = await createTestOrg({ slug: 'vat-return', vatNumber: VAT_ID, taxNumber: '999999999' } as any)
  orgId = String(org._id)
  otherOrg = await createTestOrg({ slug: 'vat-return-other', vatNumber: 'BG888888888' } as any)
  for (const role of ['accountant', 'member', 'nra_auditor', 'sales'] as const) tokens[role] = await tokenFor(org, role)
  tokens.noFile = await (signer as any).decorator.jwt.sign({
    id: String((await createTestUser(org._id, { role: 'accountant', email: 'nofile@vat.test' } as any))._id), orgId, role: 'accountant', email: 'nofile@vat.test',
    username: 'nofile', firstName: 'N', lastName: 'F', permissions: DEFAULT_ROLE_PERMISSIONS.accountant.filter(p => p !== 'accounting.file'), ownRecordsModules: [],
  })
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await TaxReturn.deleteMany({})
  await VatRegisterEntry.deleteMany({})
})

describe('importing a filed month', () => {
  it('stores it as filed: a `filed` return, frozen rows, the cells it computed', async () => {
    const plan = await importMonth(FILED)
    expect(plan.action).toBe('new')
    expect(plan.sales).toBe(9)
    expect(plan.purchases).toBe(6)

    const ret: any = await TaxReturn.findOne({ orgId, kind: 'vat', periodCode: FILED }).lean()
    expect(ret).toMatchObject({ type: 'vat', status: 'filed', source: 'imported', rowCounts: { sales: 9, purchase: 6 } })
    expect(ret.cells['01-50']).toBe(12300)
    expect(ret.netPayable).toBe(123)
    expect(ret.period.from.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(ret.period.to.toISOString()).toBe('2026-05-31T00:00:00.000Z')

    const rows = await VatRegisterEntry.find({ orgId, period: FILED }).sort({ side: 1, rowNo: 1 }).lean()
    expect(rows).toHaveLength(15)
    expect(rows.every(r => r.frozen && r.ledger === 'books')).toBe(true)
    // An annulled document is a row with no values, and `minimize` must not lose it.
    const blank = rows.find(r => r.side === 'sales' && r.rowNo === 7)!
    expect(blank.cells).toEqual({})
  })

  it('every file comes back byte for byte, proven against its recorded hash', async () => {
    await importMonth(FILED)
    for (const file of monthFiles(FILED)) {
      const res = await call('GET', `/vat/${FILED}/file/${file.name}`, tokens.accountant)
      expect(res.status).toBe(200)
      expect(sha(res.raw)).toBe(sha(file.bytes))
      expect(res.headers.get('content-disposition')).toContain(file.name)
    }
  })

  it('a nil month too, its registers empty', async () => {
    await importMonth(NIL)
    const res = await call('GET', `/vat/${NIL}/file/PRODAGBI.txt`, tokens.accountant)
    expect(res.status).toBe(200)
    expect(res.raw.length).toBe(0)
    expect((await call('GET', `/vat/${NIL}/file/VIES.txt`, tokens.accountant)).status).toBe(404)
  })

  it('is idempotent: the same files change nothing', async () => {
    await importMonth(FILED)
    const before = await VatRegisterEntry.find({ orgId }).select('_id').lean()
    const second = await importMonth(FILED)
    expect(second.action).toBe('unchanged')
    const after = await VatRegisterEntry.find({ orgId }).select('_id').lean()
    expect(after.map(r => String(r._id))).toEqual(before.map(r => String(r._id)))
    expect(await TaxReturn.countDocuments({ orgId })).toBe(1)
  })

  it('a re-filed month replaces its rows and its return, in place', async () => {
    await importMonth(FILED)
    const before: any = await TaxReturn.findOne({ orgId, periodCode: FILED }).lean()
    // A coherent re-filing: the till row is gone, and DEKLAR follows from what is left.
    const refiled = generateMonthFiles(readFiledMonth(lessTheLastSale()))

    const plan = await planVatImport(org, refiled)
    expect(plan.action).toBe('replace')
    await applyVatImport(orgId, plan)

    expect(await TaxReturn.countDocuments({ orgId, periodCode: FILED })).toBe(1)
    const after: any = await TaxReturn.findOne({ orgId, periodCode: FILED }).lean()
    expect(String(after._id)).toBe(String(before._id))
    expect(after.cells['01-01']).toBe(before.cells['01-01'] - 100000)
    expect(after.rowCounts.sales).toBe(8)
    expect(await VatRegisterEntry.countDocuments({ orgId, period: FILED, side: 'sales' })).toBe(8)
    const download = await call('GET', `/vat/${FILED}/file/DEKLAR.txt`, tokens.accountant)
    expect(sha(download.raw)).toBe(sha(refiled[0].bytes))
  })

  it('a register and a return that disagree are refused, and the month stays as it was', async () => {
    await importMonth(FILED)
    const refusal = await captureRejection(planVatImport(org, lessTheLastSale())) as VatReturnRefused
    expect(refusal.code).toBe('vat_files_differ')
    expect(refusal.message).toContain('DEKLAR.txt 1 records')
    expect(await VatRegisterEntry.countDocuments({ orgId, side: 'sales' })).toBe(9)
  })

  it('refuses a month that does not regenerate, and says how much differs, never what', async () => {
    const files = monthFiles(FILED).map(f => ({ ...f, bytes: f.bytes.slice() }))
    files.find(f => f.name === 'DEKLAR.txt')!.bytes[496] = 0x35
    const refusal = await captureRejection(planVatImport(org, files)) as VatReturnRefused
    expect(refusal.code).toBe('vat_files_differ')
    expect(refusal.message).toBe('Regenerating does not reach the filed bytes: DEKLAR.txt 1 records')
    expect(await TaxReturn.countDocuments({ orgId })).toBe(0)
  })

  it('refuses another company\'s files', async () => {
    const refusal = await captureRejection(planVatImport(otherOrg, monthFiles(FILED))) as VatReturnRefused
    expect(refusal.code).toBe('vat_files_foreign')
    expect(refusal.message).not.toContain('999999999')
  })

  it('refuses an org it cannot check the files against', async () => {
    const nameless = await createTestOrg({ slug: 'vat-return-nameless' } as any)
    const refusal = await captureRejection(planVatImport(nameless, monthFiles(FILED))) as VatReturnRefused
    expect(refusal.code).toBe('vat_org_unidentified')
  })

  it('does not overwrite a month filed from LGR', async () => {
    await openRows(OPEN)
    await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
    await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'ACK-1' })
    await TaxReturn.updateOne({ orgId, periodCode: OPEN }, { $set: { periodCode: FILED } })
    const refusal = await captureRejection(planVatImport(org, monthFiles(FILED))) as VatReturnRefused
    expect(refusal.code).toBe('vat_return_filed_here')
  })

  it('takes over a return that was only generated', async () => {
    await call('POST', `/vat/${FILED}/generate`, tokens.accountant, { ...SET_FILER })
    const plan = await importMonth(FILED)
    expect(plan.action).toBe('replace')
    const ret: any = await TaxReturn.findOne({ orgId, periodCode: FILED }).lean()
    expect(ret).toMatchObject({ status: 'filed', source: 'imported' })
    expect(await TaxReturn.countDocuments({ orgId, periodCode: FILED })).toBe(1)
  })
})

describe('generating a period', () => {
  it('numbers the rows by date, computes the return, and records each file', async () => {
    await openRows(OPEN)
    const res = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
    expect(res.status).toBe(200)
    expect(res.json.taxReturn).toMatchObject({ status: 'generated', source: 'generated', periodCode: OPEN, rowCounts: { sales: 2, purchase: 1 } })
    expect(res.json.taxReturn.cells).toMatchObject({ '01-01': 30000, '01-20': 6000, '01-41': 1000, '01-40': 1000, '01-50': 5000, '01-71': 5000 })
    expect(res.json.taxReturn.files.map((f: any) => f.name)).toEqual(['DEKLAR.txt', 'PRODAGBI.txt', 'POKUPKI.txt'])
    expect(res.json.taxReturn.declarant).toMatchObject({ vatId: VAT_ID, filer: 'ИВАН ПРИМЕРОВ' })

    const rows = await VatRegisterEntry.find({ orgId, period: OPEN, side: 'sales' }).sort({ rowNo: 1 }).lean()
    expect(rows.map(r => [r.rowNo, r.docNumber])).toEqual([[1, '0000000201'], [2, '0000000202']])
    expect(rows[0].cells['02-10']).toBe(10000)
    expect(rows[0].frozen).toBe(false)
  })

  it('names who generated it in the audit trail', async () => {
    await openRows(OPEN)
    await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
    let entry: any = null
    for (let i = 0; i < 50 && !entry; i++) {
      entry = await AuditLog.findOne({ orgId, entityType: 'tax_return', action: 'generate', entityName: `VAT ${OPEN}` }).lean()
      if (!entry) await Bun.sleep(10)
    }
    expect(entry).toBeTruthy()
  })

  it('downloads what it generated', async () => {
    await openRows(OPEN)
    const res = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
    for (const file of res.json.taxReturn.files) {
      const got = await call('GET', `/vat/${OPEN}/file/${file.name}`, tokens.member)
      expect(got.status).toBe(200)
      expect(got.raw.length).toBe(file.bytes)
      expect(sha(got.raw)).toBe(file.sha256)
    }
  })

  it('a month with no rows is a nil return, which is due all the same', async () => {
    const res = await call('POST', `/vat/${NIL}/generate`, tokens.accountant, { ...SET_FILER })
    expect(res.status).toBe(200)
    expect(res.json.taxReturn.cells ?? {}).toEqual({}) // no cell has a value, so none has a key
    expect(res.json.taxReturn.files.find((f: any) => f.name === 'PRODAGBI.txt').bytes).toBe(0)
  })

  it('asks who files, once, and remembers it from the last return', async () => {
    const first = await call('POST', `/vat/${NIL}/generate`, tokens.accountant, {})
    expect(first.status).toBe(422)
    expect(first.json).toMatchObject({ code: 'vat_declarant_missing', fields: ['filer'] })
    await call('POST', `/vat/${NIL}/generate`, tokens.accountant, { ...SET_FILER })
    const next = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, {})
    expect(next.status).toBe(200)
    expect(next.json.taxReturn.declarant.filer).toBe('ИВАН ПРИМЕРОВ')
  })

  it('a month with intra-EU supplies asks for VIES\'s declarant, and produces VIES', async () => {
    await VatRegisterEntry.create({
      orgId, period: OPEN, side: 'sales', ledger: 'books', rowNo: 0, docTypeCode: '01', docNumber: '1', docDate: new Date(Date.UTC(2026, 6, 3)),
      partnerVat: 'DE000000000', partnerName: 'MUSTER GMBH', description: 'Стоки', cells: { '02-15': 30000 }, frozen: false,
    })
    const asked = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
    expect(asked.status).toBe(422)
    expect(asked.json.fields).toEqual(expect.arrayContaining(['vies.id', 'vies.companyAddress']))

    const vies = { id: '0000000000', name: 'ИВАН ПРИМЕРОВ', city: 'София', postcode: '1000', address: 'ул. Примерна 1', kind: 'A', companyAddress: 'гр. София' }
    const res = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER, vies })
    expect(res.status).toBe(200)
    expect(res.json.taxReturn.files.map((f: any) => f.name)).toContain('VIES.txt')
    const file = await call('GET', `/vat/${OPEN}/file/VIES.txt`, tokens.accountant)
    expect(new TextDecoder('windows-1251').decode(file.raw).split('\r\n')[0]).toBe('VHR07/2026    1')
  })

  it('⚠ the VIES declarant\'s ЕГН is written to the file and to nothing a list or a get serialises', async () => {
    await importMonth(FILED)
    const lists = [await call('GET', '/vat', tokens.member), await call('GET', `/vat/${FILED}`, tokens.member), await call('GET', '/tax-return', tokens.member)]
    for (const res of lists) {
      expect(res.status).toBe(200)
      expect(JSON.stringify(res.json)).not.toContain('0000000000')
    }
    const stored: any = await TaxReturn.findOne({ orgId }).select('+declarant.vies.id').lean()
    expect(stored.declarant.vies.id).toBe('0000000000')
  })

  it('a value the file cannot carry is refused, naming the field and the record, not the value', async () => {
    await VatRegisterEntry.create({
      orgId, period: OPEN, side: 'sales', ledger: 'books', rowNo: 0, docTypeCode: '01', docNumber: '1', docDate: new Date(Date.UTC(2026, 6, 3)),
      partnerName: 'Müller 漢字', cells: {}, frozen: false,
    })
    const res = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
    expect(res.status).toBe(422)
    expect(res.json).toMatchObject({ code: 'vat_file_refused', message: '02-08 in record 1 has a character Windows-1251 cannot carry' })
    expect(await TaxReturn.countDocuments({ orgId })).toBe(0)
  })

  it('takes rows that arrived since, while the return is open', async () => {
    await openRows(OPEN)
    await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
    await VatRegisterEntry.create({
      orgId, period: OPEN, side: 'sales', ledger: 'books', rowNo: 0, docTypeCode: '01', docNumber: 'x', docDate: new Date(Date.UTC(2026, 6, 1)), cells: { '02-11': 100, '02-21': 20 }, frozen: false,
    })
    const res = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, {})
    expect(res.json.taxReturn.rowCounts.sales).toBe(3)
    expect((await VatRegisterEntry.findOne({ orgId, docNumber: 'x' }).lean())!.rowNo).toBe(1)
  })

  it('carries a declared cell through to the return', async () => {
    await openRows(OPEN)
    const res = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER, declared: { '01-70': 1500 } })
    expect(res.json.taxReturn.cells).toMatchObject({ '01-50': 5000, '01-70': 1500, '01-71': 3500 })
  })

  it('refuses a period that is no period', async () => {
    expect((await call('POST', '/vat/202613/generate', tokens.accountant, {})).status).toBe(422)
    expect((await call('GET', '/vat/nonsense', tokens.accountant)).status).toBe(422)
  })
})

describe('marking a return as filed', () => {
  const generate = async () => {
    await openRows(OPEN)
    return call('POST', `/vat/${OPEN}/generate`, tokens.accountant, { ...SET_FILER })
  }

  it('records who, when and the acknowledgement, and freezes the rows', async () => {
    await generate()
    const res = await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: '  ACK-2026-1  ' })
    expect(res.status).toBe(200)
    expect(res.json.taxReturn).toMatchObject({ status: 'filed', ack: { number: 'ACK-2026-1' } })
    expect(res.json.taxReturn.filedBy).toBeTruthy()
    expect(res.json.taxReturn.filedAt).toBeTruthy()
    expect(await VatRegisterEntry.countDocuments({ orgId, period: OPEN, frozen: false })).toBe(0)
  })

  it('stores an uploaded acknowledgement, and hands it back', async () => {
    await generate()
    const form = new FormData()
    form.set('number', 'ACK-2026-2')
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'ack.pdf', { type: 'application/pdf' }))
    const res = await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, form)
    expect(res.status).toBe(200)
    expect(res.json.taxReturn.ack.fileId).toBeTruthy()
    const stored = await FileModel.findById(res.json.taxReturn.ack.fileId).lean()
    expect(String(stored!.orgId)).toBe(orgId)
    const back = await call('GET', `/vat/${OPEN}/ack`, tokens.member)
    expect(back.status).toBe(200)
    expect([...back.raw]).toEqual([1, 2, 3])
  })

  it('a `file` that is no file is refused: an acknowledgement does not vanish without a word', async () => {
    await generate()
    const res = await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'A', file: {} })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('vat_ack_not_a_file')
    expect((await TaxReturn.findOne({ orgId }).lean())!.status).toBe('generated')
  })

  it('a return with no acknowledgement file answers 404, not a failure', async () => {
    await generate()
    await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'A' })
    expect((await call('GET', `/vat/${OPEN}/ack`, tokens.accountant)).status).toBe(404)
  })

  it('needs an acknowledgement', async () => {
    await generate()
    expect((await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, {})).status).toBe(422)
    expect((await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: '   ' })).status).toBe(422)
  })

  it('a period with no return has nothing to mark', async () => {
    const res = await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'A' })
    expect(res.status).toBe(404)
  })

  it('a row that changed after generating stops it: the files a person took are no longer what the rows say', async () => {
    await generate()
    await VatRegisterEntry.updateOne({ orgId, period: OPEN, side: 'sales', rowNo: 1 }, { $set: { 'cells.02-11': 11111, 'cells.02-10': 11111 } })
    const res = await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'A' })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('vat_return_stale')
    expect((await TaxReturn.findOne({ orgId }).lean())!.status).toBe('generated')
    expect(await VatRegisterEntry.countDocuments({ orgId, frozen: true })).toBe(0)
    // A download says the same rather than handing over other bytes.
    expect((await call('GET', `/vat/${OPEN}/file/PRODAGBI.txt`, tokens.accountant)).json.code).toBe('vat_return_stale')
  })

  it('a filed return does not generate again', async () => {
    await generate()
    await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'A' })
    const res = await call('POST', `/vat/${OPEN}/generate`, tokens.accountant, {})
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('vat_return_frozen')
  })

  it('an imported month does not generate again either', async () => {
    await importMonth(FILED)
    const res = await call('POST', `/vat/${FILED}/generate`, tokens.accountant, {})
    expect(res.json.code).toBe('vat_return_frozen')
  })

  it('a filed return is not filed twice', async () => {
    await generate()
    await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'A' })
    const res = await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'B' })
    expect(res.status).toBe(409)
    expect((await TaxReturn.findOne({ orgId }).lean())!.ack!.number).toBe('A')
  })

  it('leaves frozen rows unique: a second row cannot take a filed number', async () => {
    await generate()
    await call('POST', `/vat/${OPEN}/mark-filed`, tokens.accountant, { number: 'A' })
    const taken = await VatRegisterEntry.findOne({ orgId, period: OPEN, side: 'sales', rowNo: 1 }).lean()
    const duplicate = await captureRejection(VatRegisterEntry.create({ ...taken, _id: undefined })) as any
    expect(duplicate.code).toBe(11000)
  })
})

describe('reading a period', () => {
  it('lists the returns, newest first, with what the screen shows', async () => {
    await importMonth(FILED)
    await importMonth(NIL)
    const res = await call('GET', '/vat', tokens.member)
    expect(res.status).toBe(200)
    expect(res.json.returns.map((r: any) => r.periodCode)).toEqual([NIL, FILED])
    expect(res.json.returns[1]).toMatchObject({ status: 'filed', currency: 'EUR', rowCounts: { sales: 9, purchase: 6 } })
    expect(res.json.total).toBe(2)
  })

  it('answers for a month with no return yet, so the screen can offer Generate', async () => {
    await openRows(OPEN)
    const res = await call('GET', `/vat/${OPEN}`, tokens.member)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ period: OPEN, taxReturn: null, counts: { sales: 2, purchase: 1 }, currency: 'EUR' })
  })

  it('says the currency of the month: leva before 2026', async () => {
    expect((await call('GET', '/vat/202512', tokens.member)).json.currency).toBe('BGN')
  })

  it('pages a register, in row order', async () => {
    await importMonth(FILED)
    const page = await call('GET', `/vat/${FILED}/rows?side=sales&size=4&page=1`, tokens.member)
    expect(page.status).toBe(200)
    expect(page.json.rows.map((r: any) => r.rowNo)).toEqual([5, 6, 7, 8])
    expect(page.json.total).toBe(9)
    const purchases = await call('GET', `/vat/${FILED}/rows?side=purchase`, tokens.member)
    expect(purchases.json.rows).toHaveLength(6)
    expect(purchases.json.rows[0].cells['03-31']).toBe(50000)
  })

  it('sorts only by what it knows', async () => {
    await importMonth(FILED)
    const res = await call('GET', `/vat/${FILED}/rows?side=sales&sortBy=cells.$where&sortOrder=desc`, tokens.member)
    expect(res.status).toBe(200)
    expect(res.json.rows[0].rowNo).toBe(9)
  })

  it('a file the return does not have is a 404', async () => {
    await importMonth(FILED)
    expect((await call('GET', `/vat/${FILED}/file/secrets.txt`, tokens.member)).status).toBe(404)
    expect((await call('GET', `/vat/${OPEN}/file/DEKLAR.txt`, tokens.member)).status).toBe(404)
  })
})

describe('who may', () => {
  beforeEach(async () => {
    await openRows(OPEN)
  })

  it('reading takes any accounting permission, and no other role reads it', async () => {
    expect((await call('GET', '/vat', tokens.member)).status).toBe(200)
    expect((await call('GET', '/vat', tokens.nra_auditor)).status).toBe(200)
    expect((await call('GET', '/vat', tokens.sales)).status).toBe(403)
  })

  it('generating and marking filed take `accounting.file`, which `accounting.write` does not open', async () => {
    for (const path of [`/vat/${OPEN}/generate`, `/vat/${OPEN}/mark-filed`]) {
      for (const token of [tokens.member, tokens.nra_auditor, tokens.sales, tokens.noFile]) {
        const res = await call('POST', path, token, {})
        expect(res.status).toBe(403)
        expect(res.json.code).toBe('permission_required')
      }
    }
    expect(await TaxReturn.countDocuments({ orgId })).toBe(0)
  })

  it('another org reads none of it', async () => {
    await importMonth(FILED)
    const stranger = await tokenFor(otherOrg, 'accountant')
    const res = await call('GET', `/vat/${FILED}`, stranger)
    expect(res.status).toBe(403)
  })
})
