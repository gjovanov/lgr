import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestContact, createTestInvoice,
} from '../helpers/factories'
import { uploadPath, useTempUploadDir } from '../helpers/upload-path'
import { createApiApp } from '../../../portal-api/src/api.js'
import { config } from 'config'
import { BackgroundTask, Contact, DocFile, Product, StockLevel, StockMovement } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { analyzeDocFilesBatch } from 'services/biz/files/doc-pipeline.service'

/**
 * Booking, undoing, reconciling and analysing a document take the write permission of what it
 * books, and a snapshot's diff takes what reading stock takes.
 *
 * The Files gate (`admin.settings`) says who may use the document store. A document then issues
 * invoices and moves stock, so committing, rolling back and reconciling one ask for what the import
 * dialog asks for the same target: `invoicing.write` for invoices and cash sales, `inventory.write`
 * for movements, and the purchases area for a bill. Analysing one asks for the same, as the import
 * dialog's analysis does: it writes nothing to the books, but it matches the document against the
 * live catalog and contacts. The diff of a storeAvailability snapshot prints the live catalog's
 * quantities and prices, so it asks for any `inventory.*` permission, as a read of stock does.
 * `admin` is unaffected.
 *
 * Over HTTP, against the real route table, as `permission-set-writes.flow` does. Every refusal is
 * followed by a look at what it must not have done: no job started, the document as it was, nothing
 * booked. One real document goes through the whole road, so the person who may book still does.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
let orgId: string
let adminId: string
let warehouseId: string
let productId: string
let receiptId: string
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const tokens: Record<string, string> = {}
const started: string[] = []
let restoreUploads: () => void

async function sign(claims: object): Promise<string> {
  return (signer as any).decorator.jwt.sign(claims)
}

async function call(method: string, path: string, token: string, body: unknown = {}) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const files = (p = '') => `/api/org/${orgId}/files${p}`

/** A job's final state. Background jobs outlive the request, so wait for them. */
async function settle(taskId: string): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const r = await call('GET', files(`/task/${taskId}`), tokens.admin)
    if (r.json?.status === 'completed' || r.json?.status === 'failed') return r.json
    await Bun.sleep(50)
  }
  throw new Error(`task ${taskId} did not settle`)
}

/**
 * A job's row written as done. `completeJob` and `failJob` set the live status before they write the
 * row, and `/task/:id` reads the live one, so a settled job can still be writing. Torn down in that
 * window, the write throws "Client must be connected" with nothing to catch it, and the run counts an
 * unhandled error between tests (every master run from #536 on).
 */
async function written(taskId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const row: any = await BackgroundTask.findById(taskId).lean()
    if (row?.status === 'completed' || row?.status === 'failed') return
    await Bun.sleep(50)
  }
  throw new Error(`task ${taskId} was never written as done`)
}

/** A multipart upload, as the Files page sends it. */
async function upload(token: string, name: string, buf: Buffer) {
  const form = new FormData()
  form.append('files', new File([new Uint8Array(buf)], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const res = await app.handle(new Request(`http://localhost${files('/upload')}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

/** The request was let through: a job started. */
function expectStarted(res: { status: number; json: any }) {
  expect(res.status).toBe(200)
  expect(typeof res.json.taskId).toBe('string')
  started.push(res.json.taskId)
  return res.json.taskId as string
}

function expectRefused(res: { status: number; json: any }, message: string) {
  expect(res.status).toBe(403)
  expect(res.json?.message).toBe(message)
}

const jobs = () => BackgroundTask.countDocuments({ orgId })
const movements = () => StockMovement.countDocuments({ orgId })
const docRow = (id: string) => DocFile.findById(id).lean().exec() as Promise<any>
async function stockOf(): Promise<number> {
  const sl: any = await StockLevel.findOne({ orgId, productId, warehouseId }).lean()
  return Number(sl?.quantity) || 0
}

let seq = 0
/** A document row with no bytes: enough for the routes that decide before reading any. */
async function mkDoc(overrides: Record<string, unknown> = {}): Promise<any> {
  const n = ++seq
  return DocFile.create({
    orgId, docType: 'goods_receipt', docNumber: `fba-${n}`, docDate: '2026-11-05',
    originalName: `fba-${n}.pdf`, currentPath: `fba-${n}.pdf`, currentChecksum: `sum-${n}`,
    mimeType: 'application/pdf', size: 1, uploadedBy: adminId, ...overrides,
  } as any)
}

/** A storeOperations „Доставки" (receipt) export: analyzes and commits with no OCR sidecar. */
async function storeOperationsBook(items: Array<[string, number]>, period: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  ws.getRow(2).getCell(1).value = 'Склад: ОБЕКТИ:СКЛАД - 1'
  ws.getRow(3).getCell(1).value = `Период: ${period}`
  ws.getRow(4).getCell(1).value = 'Операция: Доставки'
  ws.getRow(9).getCell(1).value = 'Име'; ws.getRow(9).getCell(2).value = 'Мярка'
  ws.getRow(9).getCell(3).value = 'Количество'; ws.getRow(9).getCell(4).value = 'Цена'; ws.getRow(9).getCell(5).value = 'Стойност'
  let r = 10
  for (const [name, qty] of items) { const row = ws.getRow(r); row.getCell(1).value = name; row.getCell(2).value = 'БР'; row.getCell(3).value = qty; row.getCell(4).value = 1; row.getCell(5).value = qty; r++ }
  ws.getRow(r).getCell(1).value = 'Всичко'; ws.getRow(r).getCell(3).value = items.reduce((s, i) => s + i[1], 0)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/**
 * A storeAvailability-shaped xlsx (headers on row 5, data from row 6) with one row for the catalog's
 * product. Every heading is written, as `compare-snapshot.flow.test.ts` explains: price columns are
 * resolved by name.
 */
async function snapshotBook(qty: number): Promise<Buffer> {
  const headings = ['Име', 'Мярка', 'Количество', 'Дост. цена', 'Прод. цена',
    'Цена на едро', 'Цена 0', 'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4', 'Цена 5', 'Цена 6', 'Цена 7', 'Цена 8', 'Цена 9']
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  headings.forEach((h, i) => { ws.getRow(5).getCell(1 + i).value = h })
  const row = ws.getRow(6)
  row.getCell(1).value = 'Гайка М8'; row.getCell(2).value = 'бр'; row.getCell(3).value = qty
  row.getCell(4).value = 0; row.getCell(5).value = 0
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// Documents the tests below share; each is built once.
let snapshotId: string         // a real storeAvailability snapshot, with bytes: its diff can run
let invoiceId: string          // analyzed as a sales invoice
let salesDayId: string         // a „Складови операции" document whose analysis says cash sale
let billId: string             // analyzed as a bill
let plainId: string            // a snapshot: nothing to book
let uploadedId: string         // uploaded only: nothing booked
let bookedInvoiceId: string    // committed, booked a sales invoice
let bookedBillId: string       // committed, booked an incoming invoice

beforeAll(async () => {
  await setupTestDB()
  restoreUploads = useTempUploadDir()
  app = new Elysia().use(createApiApp())
  const org = await createTestOrg({ slug: 'files-books-access' } as any)
  orgId = String(org._id)

  const warehouse = await createTestWarehouse(org._id, { isDefault: true, name: 'Main' } as any)
  warehouseId = String(warehouse._id)
  const product = await createTestProduct(org._id, { name: 'Гайка М8', sku: 'GM8' } as any)
  productId = String(product._id)

  const admin = await createTestUser(org._id, { role: 'admin', email: 'admin@fba.test', username: 'fba-admin' } as any)
  const member = await createTestUser(org._id, { role: 'member', email: 'member@fba.test', username: 'fba-member' } as any)
  adminId = String(admin._id)

  // What sign-in issues, with the permissions of each case written over it.
  const claims = await tokenize(member)
  tokens.admin = await sign(await tokenize(admin))
  tokens.plain = await sign(claims)   // a member: no admin.settings, so no Files at all
  tokens.nobody = await sign({ ...claims, permissions: ['admin.settings'] })
  tokens.clerk = await sign({ ...claims, permissions: ['admin.settings', 'inventory.write'] })
  tokens.biller = await sign({ ...claims, permissions: ['admin.settings', 'invoicing.write'] })
  tokens.sellerLike = await sign({ ...claims, permissions: ['admin.settings', 'invoicing.write', 'inventory.write'], areas: [] })
  tokens.buyer = await sign({ ...claims, permissions: ['admin.settings', 'invoicing.write'], areas: ['purchases'] })
  tokens.reader = await sign({ ...claims, permissions: ['admin.settings', 'inventory.read'] })   // reads stock, writes nothing

  // The one real document: a receipt, analyzed by the engine, committed through the route below.
  const buf = await storeOperationsBook([['Гайка М8', 100]], '05.11.2026 - 05.11.2026')
  const path = uploadPath(org._id, 'fba-receipt.xlsx')
  await Bun.write(path, buf)
  const receipt: any = await DocFile.create({
    orgId: org._id, docType: 'store_operations', docNumber: '20261105_120000', docDate: '2026-11-05',
    originalName: 'storeOperations_20261105_120000.xlsx', currentPath: path, currentChecksum: 'receipt',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buf.length, uploadedBy: admin._id,
  })
  receiptId = String(receipt._id)
  await analyzeDocFilesBatch(orgId, adminId, [receiptId])

  const snapshotBuf = await snapshotBook(3)
  const snapshotPath = uploadPath(org._id, 'fba-snapshot.xlsx')
  await Bun.write(snapshotPath, snapshotBuf)
  snapshotId = String((await mkDoc({
    docType: 'store_availability', docNumber: '20261105_150000', originalName: 'storeAvailability_20261105_150000.xlsx',
    currentPath: snapshotPath, currentChecksum: 'snapshot', size: snapshotBuf.length,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }))._id)

  invoiceId = String((await mkDoc({ docType: 'invoice', status: 'analyzed', analysis: { target: 'sales_invoice' } }))._id)
  // A sales day is a „Складови операции" document too: its docType says movement, its analysis says cash sale.
  salesDayId = String((await mkDoc({ docType: 'store_operations', status: 'analyzed', analysis: { target: 'cash_sale' } }))._id)
  billId = String((await mkDoc({ docType: 'invoice', status: 'analyzed', analysis: { target: 'bill' } }))._id)
  plainId = String((await mkDoc({ docType: 'store_availability' }))._id)
  uploadedId = String((await mkDoc({ status: 'uploaded' }))._id)

  const contact = await createTestContact(org._id)
  const sale = await createTestInvoice(org._id, contact._id as any, { status: 'sent' } as any)
  const bill = await createTestInvoice(org._id, contact._id as any, { status: 'sent', direction: 'incoming' } as any)
  bookedInvoiceId = String((await mkDoc({ docType: 'invoice', status: 'committed', committedTarget: 'invoice', committedIds: [sale._id] }))._id)
  bookedBillId = String((await mkDoc({ docType: 'invoice', status: 'committed', committedTarget: 'invoice', committedIds: [bill._id] }))._id)
}, 120_000)

afterAll(async () => {
  await Promise.all(started.map(settle))
  await Promise.all(started.map(written))
  restoreUploads()
  await teardownTestDB()
})

describe('the real document is what the tests think it is', () => {
  it('the receipt was analyzed as a movement and nothing is booked yet', async () => {
    const row = await docRow(receiptId)
    expect(row.analysis.target).toBe('movement')
    expect(row.status).toBe('analyzed')
    expect(await movements()).toBe(0)
    expect(await stockOf()).toBe(0)
  })
})

describe('booking a document takes the write permission of what it books', () => {
  it('admin.settings alone is refused, on both commit routes: no job, the document as it was, nothing booked', async () => {
    const before = await docRow(receiptId)
    const jobsBefore = await jobs()

    expectRefused(await call('POST', files('/commit-batch'), tokens.nobody, { docFileIds: [receiptId] }), 'Permission required: inventory.write')
    expectRefused(await call('POST', files(`/${receiptId}/commit`), tokens.nobody, {}), 'Permission required: inventory.write')

    expect(await jobs()).toBe(jobsBefore)
    const after = await docRow(receiptId)
    expect(after.status).toBe('analyzed')
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(await movements()).toBe(0)
  })

  it('and it is the permission of the target, not any write', async () => {
    // Invoicing is not inventory.
    expectRefused(await call('POST', files('/commit-batch'), tokens.biller, { docFileIds: [receiptId] }), 'Permission required: inventory.write')
    // Inventory is not invoicing.
    expectRefused(await call('POST', files('/commit-batch'), tokens.clerk, { docFileIds: [invoiceId] }), 'Permission required: invoicing.write')
    expectRefused(await call('POST', files(`/${invoiceId}/commit`), tokens.clerk, {}), 'Permission required: invoicing.write')
    expect(await movements()).toBe(0)
  })

  it('a document is held to the target it was analyzed as, not to its docType', async () => {
    // docType store_operations reads as a movement; this one was analyzed as a cash sale.
    expectRefused(await call('POST', files('/commit-batch'), tokens.clerk, { docFileIds: [salesDayId] }), 'Permission required: invoicing.write')
    expectStarted(await call('POST', files('/commit-batch'), tokens.biller, { docFileIds: [salesDayId] }))
  })

  it('a bill also takes the purchases area', async () => {
    const res = await call('POST', files('/commit-batch'), tokens.sellerLike, { docFileIds: [billId] })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('area_required')
    expect(res.json.area).toBe('purchases')
    expectStarted(await call('POST', files('/commit-batch'), tokens.buyer, { docFileIds: [billId] }))
  })

  it('one document in a batch the caller may not book refuses the whole batch', async () => {
    const jobsBefore = await jobs()
    expectRefused(await call('POST', files('/commit-batch'), tokens.clerk, { docFileIds: [receiptId, invoiceId] }), 'Permission required: invoicing.write')
    expect(await jobs()).toBe(jobsBefore)
    expect(await movements()).toBe(0)
  })

  it('a document with nothing to book asks for nothing more', async () => {
    expectStarted(await call('POST', files(`/${plainId}/commit`), tokens.nobody, {}))
  })

  it('the person with the permission still books it, end to end', async () => {
    const taskId = expectStarted(await call('POST', files('/commit-batch'), tokens.clerk, { docFileIds: [receiptId] }))
    const done = await settle(taskId)
    expect(done.status).toBe('completed')
    expect(done.result.results[0].ok).toBe(true)
    expect((await docRow(receiptId)).status).toBe('committed')
    expect(await movements()).toBe(1)
    expect(await stockOf()).toBe(100)
  })

  it('an administrator is unaffected', async () => {
    expectStarted(await call('POST', files('/commit-batch'), tokens.admin, { docFileIds: [invoiceId, billId, salesDayId] }))
    expectStarted(await call('POST', files(`/${invoiceId}/commit`), tokens.admin, {}))
  })
})

describe('undoing a document takes the permission of the records it booked', () => {
  it('a movement: refused without inventory.write, dry run or not, and nothing is undone', async () => {
    const jobsBefore = await jobs()
    for (const who of ['nobody', 'biller']) {
      expectRefused(await call('POST', files('/delete-batch'), tokens[who], { docFileIds: [receiptId] }), 'Permission required: inventory.write')
      expectRefused(await call('POST', files('/delete-batch'), tokens[who], { docFileIds: [receiptId], execute: true }), 'Permission required: inventory.write')
    }
    expect(await jobs()).toBe(jobsBefore)
    expect(await docRow(receiptId)).not.toBeNull()
    expect(await stockOf()).toBe(100)
    expect(await movements()).toBe(1)
  })

  it('and the person who holds it still gets the plan', async () => {
    const taskId = expectStarted(await call('POST', files('/delete-batch'), tokens.clerk, { docFileIds: [receiptId] }))
    const done = await settle(taskId)
    expect(done.status).toBe('completed')
    expect(done.result.executed).toBe(false)
    expect(done.result.plans[0].movements[0].action).toBe('reverse')
    expect(await stockOf()).toBe(100)
  })

  it('an invoice takes invoicing.write', async () => {
    expectRefused(await call('POST', files('/delete-batch'), tokens.clerk, { docFileIds: [bookedInvoiceId] }), 'Permission required: invoicing.write')
    expectStarted(await call('POST', files('/delete-batch'), tokens.biller, { docFileIds: [bookedInvoiceId] }))
  })

  it('a bill also takes the purchases area', async () => {
    const res = await call('POST', files('/delete-batch'), tokens.sellerLike, { docFileIds: [bookedBillId] })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('area_required')
    expectStarted(await call('POST', files('/delete-batch'), tokens.buyer, { docFileIds: [bookedBillId] }))
  })

  it('without a rollback only the file and its row go, so the bookings ask for nothing', async () => {
    expectStarted(await call('POST', files('/delete-batch'), tokens.nobody, { docFileIds: [receiptId], rollback: false }))
  })

  it('a document that booked nothing asks for nothing', async () => {
    expectStarted(await call('POST', files('/delete-batch'), tokens.nobody, { docFileIds: [uploadedId] }))
  })

  it('deactivating products is a stock write, whatever the document was', async () => {
    expectRefused(await call('POST', files('/delete-batch'), tokens.nobody, { docFileIds: [uploadedId], removeProducts: true }), 'Permission required: inventory.write')
    expectRefused(await call('POST', files('/delete-batch'), tokens.biller, { docFileIds: [bookedInvoiceId], removeProducts: true }), 'Permission required: inventory.write')
    expectStarted(await call('POST', files('/delete-batch'), tokens.clerk, { docFileIds: [uploadedId], removeProducts: true }))
  })

  it('an administrator is unaffected', async () => {
    expectStarted(await call('POST', files('/delete-batch'), tokens.admin, { docFileIds: [receiptId, bookedInvoiceId, bookedBillId] }))
  })
})

describe('reconciling a document takes inventory.write', () => {
  it('refused without it', async () => {
    const jobsBefore = await jobs()
    expectRefused(await call('POST', files(`/${receiptId}/reconcile`), tokens.nobody), 'Permission required: inventory.write')
    expectRefused(await call('POST', files(`/${receiptId}/reconcile?execute=true`), tokens.biller), 'Permission required: inventory.write')
    expect(await jobs()).toBe(jobsBefore)
    expect(await movements()).toBe(1)
  })

  it('and the person who holds it, and an administrator, still reconcile', async () => {
    expectStarted(await call('POST', files(`/${receiptId}/reconcile`), tokens.clerk))
    expectStarted(await call('POST', files(`/${receiptId}/reconcile`), tokens.admin))
  })
})

describe('analysing a document takes the write permission of what it maps into', () => {
  it('admin.settings alone is refused, on both analyze routes: no job, the document as it was, no contact or product made', async () => {
    const before = await docRow(uploadedId)
    const jobsBefore = await jobs()
    const contactsBefore = await Contact.countDocuments({ orgId })
    const productsBefore = await Product.countDocuments({ orgId })

    expectRefused(await call('POST', files('/analyze-batch'), tokens.nobody, { docFileIds: [uploadedId] }), 'Permission required: inventory.write')
    expectRefused(await call('POST', files(`/${uploadedId}/analyze`), tokens.nobody, {}), 'Permission required: inventory.write')

    expect(await jobs()).toBe(jobsBefore)
    const after = await docRow(uploadedId)
    expect(after.status).toBe('uploaded')
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(after.analysis ?? null).toEqual(before.analysis ?? null)
    expect(await Contact.countDocuments({ orgId })).toBe(contactsBefore)
    expect(await Product.countDocuments({ orgId })).toBe(productsBefore)
  })

  it('and it is the permission of the target, not any write', async () => {
    // Invoicing is not inventory.
    expectRefused(await call('POST', files('/analyze-batch'), tokens.biller, { docFileIds: [uploadedId] }), 'Permission required: inventory.write')
    // Inventory is not invoicing.
    expectRefused(await call('POST', files('/analyze-batch'), tokens.clerk, { docFileIds: [invoiceId] }), 'Permission required: invoicing.write')
    expectRefused(await call('POST', files(`/${invoiceId}/analyze`), tokens.clerk, {}), 'Permission required: invoicing.write')
  })

  it('a document is held to the target it was analyzed as, not to its docType', async () => {
    // docType store_operations reads as a movement; this one was analyzed as a cash sale.
    expectRefused(await call('POST', files('/analyze-batch'), tokens.clerk, { docFileIds: [salesDayId] }), 'Permission required: invoicing.write')
    expectStarted(await call('POST', files('/analyze-batch'), tokens.biller, { docFileIds: [salesDayId] }))
  })

  it('a bill also takes the purchases area', async () => {
    const res = await call('POST', files('/analyze-batch'), tokens.sellerLike, { docFileIds: [billId] })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('area_required')
    expect(res.json.area).toBe('purchases')
    expectStarted(await call('POST', files(`/${billId}/analyze`), tokens.buyer, {}))
  })

  it('one document in a batch the caller may not analyze refuses the whole batch', async () => {
    const jobsBefore = await jobs()
    expectRefused(await call('POST', files('/analyze-batch'), tokens.clerk, { docFileIds: [uploadedId, invoiceId] }), 'Permission required: invoicing.write')
    expect(await jobs()).toBe(jobsBefore)
  })

  it('a document with no target asks for nothing more, and the job says it cannot be analyzed', async () => {
    const taskId = expectStarted(await call('POST', files(`/${plainId}/analyze`), tokens.nobody, {}))
    const done = await settle(taskId)
    expect(done.status).toBe('failed')
    expect(String(done.error)).toContain('not analyzable')
  })

  it('the person with the permission still analyzes a document end to end, and analysing books nothing', async () => {
    const buf = await storeOperationsBook([['Гайка М8', 7]], '06.11.2026 - 06.11.2026')
    const path = uploadPath(orgId, 'fba-fresh.xlsx')
    await Bun.write(path, buf)
    const fresh: any = await DocFile.create({
      orgId, docType: 'store_operations', docNumber: '20261106_090000', docDate: '2026-11-06',
      originalName: 'storeOperations_20261106_090000.xlsx', currentPath: path, currentChecksum: 'fresh',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buf.length, uploadedBy: adminId,
    })
    const freshId = String(fresh._id)
    const movementsBefore = await movements()
    const stockBefore = await stockOf()
    const contactsBefore = await Contact.countDocuments({ orgId })

    const taskId = expectStarted(await call('POST', files('/analyze-batch'), tokens.clerk, { docFileIds: [freshId] }))
    const done = await settle(taskId)
    expect(done.status).toBe('completed')
    expect(done.result.results[0].error).toBeFalsy()
    const row = await docRow(freshId)
    expect(row.status).toBe('analyzed')
    expect(row.analysis.target).toBe('movement')
    expect(row.analysis.mapped).toBeTruthy()

    // The single-document route, by the same person.
    const again = await settle(expectStarted(await call('POST', files(`/${freshId}/analyze`), tokens.clerk, {})))
    expect(again.status).toBe('completed')

    expect(await movements()).toBe(movementsBefore)
    expect(await stockOf()).toBe(stockBefore)
    expect(await Contact.countDocuments({ orgId })).toBe(contactsBefore)
  })

  it('an administrator is unaffected', async () => {
    expectStarted(await call('POST', files('/analyze-batch'), tokens.admin, { docFileIds: [invoiceId, billId, salesDayId, uploadedId] }))
    expectStarted(await call('POST', files(`/${invoiceId}/analyze`), tokens.admin, {}))
  })
})

describe("a snapshot's diff takes what reading stock takes", () => {
  it('admin.settings alone is refused, on both routes: nothing is shown and nothing is written', async () => {
    const before = await docRow(snapshotId)
    for (const who of ['nobody', 'biller']) {   // invoicing is not inventory either
      const run = await call('POST', files(`/${snapshotId}/compare`), tokens[who])
      expect(run.status).toBe(403)
      expect(String(run.json.message).startsWith('Permission required: inventory.read')).toBe(true)
      expect(run.json.permissions).toContain('inventory.read')
      expect(run.json.permissions).toContain('inventory.write')
      // The refusal carries none of what it refuses.
      expect(run.json.summary).toBeUndefined()
      expect(run.json.rows).toBeUndefined()
      expect(run.json.txt).toBeUndefined()
      for (const format of ['txt', 'csv']) {
        expect((await call('GET', files(`/${snapshotId}/compare/download?format=${format}`), tokens[who])).status).toBe(403)
      }
    }
    const after = await docRow(snapshotId)
    expect(after.status).toBe(before.status)
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(after.compareSummary ?? null).toBeNull()
  })

  it('the Files gate still comes first', async () => {
    const res = await call('POST', files(`/${snapshotId}/compare`), tokens.plain)
    expect(res.status).toBe(403)
    expect(res.json.message).toBe('Administrator access required')
  })

  let comparedId: string   // a snapshot an upload stored AND compared: its dump is where the download looks

  it('an upload stores the snapshot for anyone with the Files gate, and compares it only for a reader of stock', async () => {
    // Without the permission: stored, not compared, and told why. No stock figure comes back.
    const denied = await upload(tokens.nobody, 'storeAvailability_20261106_110000.xlsx', await snapshotBook(1))
    expect(denied.status).toBe(200)
    const stored = denied.json.results[0]
    expect(stored.docType).toBe('store_availability')
    expect(stored.outcome).toBe('created')
    expect(String(stored.compare?.error).startsWith('Permission required: inventory.read')).toBe(true)
    expect(stored.compare.snapshotRows).toBeUndefined()
    const storedRow = await docRow(stored.docFileId)
    expect(storedRow.compareSummary ?? null).toBeNull()
    expect(storedRow.status).not.toBe('committed')

    // With it, the diff runs as it always did.
    const allowed = await upload(tokens.reader, 'storeAvailability_20261106_120000.xlsx', await snapshotBook(2))
    expect(allowed.status).toBe(200)
    const compared = allowed.json.results[0]
    expect(compared.compare.snapshotRows).toBe(1)
    expect((await docRow(compared.docFileId)).status).toBe('committed')
    comparedId = compared.docFileId
  })

  it('whoever may read stock still sees the diff, and an administrator', async () => {
    for (const who of ['reader', 'clerk', 'admin']) {
      const res = await call('POST', files(`/${snapshotId}/compare`), tokens[who])
      expect(res.status).toBe(200)
      expect(res.json.summary.snapshotRows).toBe(1)
      expect(Array.isArray(res.json.rows)).toBe(true)
    }
    // The dump the upload's diff left beside the snapshot comes back as it did.
    expect((await call('GET', files(`/${comparedId}/compare/download?format=csv`), tokens.reader)).status).toBe(200)
    expect((await call('GET', files(`/${comparedId}/compare/download?format=txt`), tokens.admin)).status).toBe(200)
    // And the one without the permission is still refused it.
    expect((await call('GET', files(`/${comparedId}/compare/download?format=csv`), tokens.nobody)).status).toBe(403)
  })
})

describe('the rest of the Files gate is as it was', () => {
  it('admin.settings still opens the document store, and its absence still closes it', async () => {
    expect((await call('GET', files(), tokens.nobody)).status).toBe(200)
    expect((await call('GET', files('/audit'), tokens.nobody)).status).toBe(200)
    expect((await call('GET', files(), tokens.plain)).status).toBe(403)
    expect((await call('POST', files('/commit-batch'), tokens.plain, { docFileIds: [receiptId] })).status).toBe(403)
  })
})
