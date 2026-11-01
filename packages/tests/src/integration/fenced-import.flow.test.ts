import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestAccount, createTestContact, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AuditLog, FencedExport, FencedImportItem, Invoice, Journal, JournalEntry, OrgHome, OrgMove, POSSession, Sequence, StockLevel, StockMovement } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { fencedExportPath, fencedExportsOf, receiveFencedChunk, writeFencedExport } from 'services/biz/move/fenced-export.service'
import { fencedImportTick, requestFencedImport } from 'services/biz/move/fenced-import.service'; import { freezeRefusal, receiptInDoubt, settleReceipt } from 'services/biz/cash-register/payment-receipt.service'; import { deviceless } from 'invoicing-api/src/lib/counter-receipt'

/**
 * The audited import of a fenced export (FR-20.84, plan step P3-6e, second half): a replaced
 * server's sales, kept as they were and booked on lgrai.app, the rest listed for a person.
 *
 * The export is the real one: written by `writeFencedExport` from a second database playing the
 * site, and received by `receiveFencedChunk`.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const saved = { role: config.node.role, upload: config.upload.dir }
const NODE = 'master-fencedimporttest'
let root = ''
let siteDbName = ''
let n = 0

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'global'
  root = mkdtempSync(join(tmpdir(), 'lgr-fi-'))
  siteDbName = `site_fi_${++n}`
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.upload as any).dir = saved.upload
  forgetAllHomes()
  await (mongoose.connection as any).client.db(siteDbName).dropDatabase().catch(() => {})
  rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

const db = () => mongoose.connection.db as any
const oid = () => new mongoose.Types.ObjectId()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const year = new Date().getFullYear()
const line = (productId: unknown, warehouseId: unknown, quantity: number, unitPrice = 10) => ({
  _id: oid(), productId, warehouseId, description: 'goods', quantity, unit: 'pcs', unitPrice, discount: 0, taxRate: 20,
  taxAmount: +(quantity * unitPrice * 0.2).toFixed(2), lineTotal: +(quantity * unitPrice * 1.2).toFixed(2),
})

/** lgrai.app after a promotion, and what the replaced server did after the cutoff, as its export. */
async function world(o: { deadReceipt?: boolean } = {}) {
  const org = await createTestOrg({ slug: `fenced-import-${n}` } as any)
  const orgId = org._id as any
  const admin = await createTestUser(orgId, { role: 'admin' } as any)
  const customer = await createTestContact(orgId, { companyName: 'Customer from before', type: 'customer' } as any)
  const wh = await createTestWarehouse(orgId)
  const bolt = await createTestProduct(orgId, { name: 'Bolt M8', sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(orgId, bolt._id as any, wh._id as any, { quantity: 10 })
  // Accounting, so every booking shows as an entry.
  const receivable = await createTestAccount(orgId, { name: 'Receivable', type: 'asset' } as any)
  const revenue = await createTestAccount(orgId, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
  const sales = await Journal.create({ orgId, name: 'Sales', code: `S${n}${Date.now() % 10000}`, type: 'sale' } as any)
  const cash = await createTestAccount(orgId, { name: 'Bank account', type: 'asset' } as any)
  const bank = await Journal.create({ orgId, name: 'Bank', code: `B${n}${Date.now() % 10000}`, type: 'bank', defaultDebitAccountId: cash._id, defaultCreditAccountId: cash._id } as any)
  await db().collection('orgs').updateOne({ _id: orgId }, { $set: { 'settings.accounting': { defaultReceivableAccountId: receivable._id, defaultRevenueAccountId: revenue._id, defaultSaleJournalId: sales._id, defaultBankJournalId: bank._id, defaultCashJournalId: bank._id } } })
  // What lgrai.app did after the promotion: an invoice numbered 42, a draft numbered 3, a movement SM-…-00007.
  const ours42 = oid()
  await db().collection('invoices').insertMany([
    { _id: ours42, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00042`, status: 'sent', issueDate: new Date(), contactId: customer._id, currency: 'EUR', total: 12, subtotal: 10, taxTotal: 2, lines: [], payments: [] },
    { _id: oid(), orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `DRF-INV-${year}-00003`, status: 'draft', issueDate: new Date(), contactId: customer._id, currency: 'EUR', total: 0, lines: [], payments: [] },
  ])
  await db().collection('stockmovements').insertOne({ _id: oid(), orgId, movementNumber: `SM-${year}-00007`, type: 'adjustment', status: 'confirmed', date: new Date(), lines: [] })
  await Sequence.collection.insertMany([
    { orgId, prefix: 'SALES_DOC', year, lastNumber: 42 },
    { orgId, prefix: 'DRAFT_INV', year, lastNumber: 3 },
  ] as any)

  // ── the site, in its own database ──
  const site = (mongoose.connection as any).client.db(siteDbName)
  const ids = {
    newCustomer: oid(), newProduct: oid(), session: oid(), invoice50: oid(), cashSale: oid(), draft: oid(), clash: oid(),
    missing: oid(), paid52: oid(), saleMovement: oid(), receipt: oid(), doc: oid(), audit: oid(), je: oid(), gone: oid(), payment: oid(), held: oid(), dead: oid(),
  }
  const at = new Date()
  const newCustomer = { _id: ids.newCustomer, orgId, companyName: 'Sold to after the cutoff', type: 'customer', isActive: true }
  const newProduct = { _id: ids.newProduct, orgId, name: 'Nut M8', sku: `NUT-${n}`, sellingPrice: 10, taxRate: 20, isActive: true }
  const session = { _id: ids.session, orgId, sessionNumber: 'POS-2026-000009', status: 'closed', warehouseId: wh._id, cashierId: admin._id, openedAt: at, closedAt: at, openingBalance: 0, closingBalance: 36, totalSales: 36, totalCash: 36, journalEntryId: ids.je }
  const invoice50 = { _id: ids.invoice50, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00050`, status: 'sent', issueDate: at, createdAt: at, contactId: ids.newCustomer, currency: 'EUR', exchangeRate: 1, subtotal: 20, taxTotal: 4, total: 24, amountPaid: 0, amountDue: 24, lines: [line(bolt._id, wh._id, 2)], payments: [], journalEntryId: ids.je }
  const cashSale = {
    _id: ids.cashSale, orgId, type: 'cash_sale', direction: 'outgoing', invoiceNumber: `CS-${year}-00010`, status: 'paid', issueDate: at, currency: 'EUR', exchangeRate: 1, subtotal: 30, taxTotal: 6, total: 36, amountPaid: 36, amountDue: 0,
    lines: [line(ids.newProduct, wh._id, 3)], payments: [{ _id: oid(), method: 'cash', amount: 36, date: at }],
    register: { origin: 'pos', sessionId: ids.session, warehouseId: wh._id, unp: 'ED123456-0001-0000007', fiscal: { mode: 'fiscal', state: 'printed' }, movementId: ids.saleMovement, sessionTotalsApplied: true },
    completedAt: at,
  }
  const draft = { _id: ids.draft, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `DRF-INV-${year}-00003`, status: 'draft', issueDate: at, contactId: customer._id, currency: 'EUR', total: 0, lines: [], payments: [] }
  const clash = { _id: ids.clash, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00042`, status: 'sent', issueDate: at, contactId: customer._id, currency: 'EUR', total: 12, lines: [line(bolt._id, wh._id, 1)], payments: [] }
  const missing = { _id: ids.missing, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00051`, status: 'sent', issueDate: at, contactId: customer._id, currency: 'EUR', total: 12, lines: [line(oid(), wh._id, 1)], payments: [] }
  const paid52 = { _id: ids.paid52, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00052`, status: 'paid', issueDate: at, contactId: customer._id, currency: 'EUR', exchangeRate: 1, subtotal: 10, taxTotal: 2, total: 12, amountPaid: 12, amountDue: 0, lines: [line(bolt._id, wh._id, 1)], payments: [{ _id: ids.payment, method: 'bank_transfer', amount: 12, date: at, journalEntryId: ids.je }] }
  const saleMovement = { _id: ids.saleMovement, orgId, movementNumber: `SM-${year}-00099`, type: 'dispatch', status: 'completed', date: at, invoiceId: ids.cashSale, lines: [] }
  const receipt = { _id: ids.receipt, orgId, movementNumber: `SM-${year}-00007`, type: 'receipt', status: 'completed', date: at, toWarehouseId: wh._id, lines: [{ productId: bolt._id, quantity: 5, unitCost: 4, totalCost: 20 }] }
  const content = randomBytes(2000)
  const rel = `${String(orgId)}/docs/2026-10-27/late.pdf`
  const doc = { _id: ids.doc, orgId, docType: 'invoice', docNumber: 'late', docDate: '2026-10-27', originalName: 'late.pdf', currentPath: rel, currentChecksum: sha(content), version: 1, mimeType: 'application/pdf', size: content.length, status: 'uploaded', uploadedAt: at }
  const audit = { _id: ids.audit, orgId, userId: admin._id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: ids.invoice50, entityName: `INV-${year}-00050`, createdAt: at }
  const je = { _id: ids.je, orgId, entryNumber: `JE-${year}-00009`, date: at, lines: [] }
  await site.collection('contacts').insertOne(newCustomer)
  await site.collection('products').insertOne(newProduct)
  await site.collection('possessions').insertOne(session)
  await site.collection('invoices').insertMany([invoice50, cashSale, draft, clash, missing, paid52])
  await site.collection('stockmovements').insertMany([saleMovement, receipt])
  await site.collection('docfiles').insertOne(doc)
  await site.collection('auditlogs').insertOne(audit)
  await site.collection('journalentries').insertOne(je)
  const dead = { _id: ids.dead, orgId, type: 'payment_receipt', direction: 'outgoing', invoiceNumber: `CS-${year}-00011`, status: 'paid', issueDate: at, createdAt: at, currency: 'EUR', exchangeRate: 1, total: 24, paymentMethod: 'cash', payments: [], leaseUntil: at, register: { origin: 'invoice', sessionId: ids.session, warehouseId: wh._id, paidInvoiceId: ids.held, paidInvoiceNumber: `INV-${year}-00053`, unp: 'ED123456-0001-0000008', tendered: { method: 'cash', amount: 24, date: at }, fiscal: { mode: 'fiscal', state: 'pending', attemptedAt: at, counterBefore: 7 } } }; if (o.deadReceipt) await site.collection('invoices').insertMany([{ ...invoice50, _id: ids.held, invoiceNumber: `INV-${year}-00053`, receiptHolds: [{ receiptId: ids.dead, amount: 24 }] }, dead]); const journal: Array<[string, unknown, string?]> = [
    ['contacts', ids.newCustomer], ['products', ids.newProduct], ['possessions', ids.session],
    ['invoices', ids.invoice50], ['invoices', ids.cashSale], ['invoices', ids.draft], ['invoices', ids.clash], ['invoices', ids.missing], ['invoices', ids.paid52],
    ['stockmovements', ids.saleMovement], ['stockmovements', ids.receipt], ['docfiles', ids.doc], ['auditlogs', ids.audit], ['journalentries', ids.je],
    ['contacts', ids.gone, 'delete'], ...(o.deadReceipt ? [['invoices', ids.held], ['invoices', ids.dead]] as Array<[string, unknown]> : []),
  ]
  await site.collection('repl_journal').insertMany(journal.map(([coll, docId, op], i) => ({ orgId, coll, docId, seq: 11 + i, op: op ?? 'upsert', changedFields: [], clusterTime: at, journalEpoch: 1, updatedAt: at })))
  await site.collection('repl_orgs').insertOne({ orgId, enabled: true, seq: 11 + journal.length, pages: [] })
  ;(config.upload as any).dir = join(root, 'site')
  mkdirSync(dirname(join(root, 'site', ...rel.split('/'))), { recursive: true })
  writeFileSync(join(root, 'site', ...rel.split('/')), content)

  // The promotion, and its export received on lgrai.app.
  const move: any = (await OrgMove.create({ orgId, kind: 'promote', state: 'done', from: NODE, to: 'global', epochFrom: 1, epochTo: 2, startedBy: admin._id, startedAt: at, endedAt: at, fenceCutoff: 10, fenceJournalEpoch: 1, allowMissing: [] } as any)).toObject()
  const local = join(root, 'export.ndjson.zst')
  const w = await writeFencedExport(site, { orgId, nodeId: NODE, moveId: String(move._id), cutoff: 10, journalEpoch: 1 }, local)
  ;(config.upload as any).dir = join(root, 'global')
  const r = await receiveFencedChunk(NODE, String(move._id), { offset: 0, size: w.size, sha256: w.sha256 }, readFileSync(local))
  expect(r.state).toBe('received')
  const ex: any = await FencedExport.findOne({ moveId: move._id }).lean()
  return { orgId: String(orgId), oid: orgId, admin, customer, wh, bolt, ids, ours42, ex, content, rel, sales, bank }
}

/** The import's ticks, until it is done. */
async function runToEnd(exportId: unknown) {
  for (let i = 0; i < 20; i++) {
    await fencedImportTick()
    const row: any = await FencedExport.findById(exportId).lean()
    if (row?.import?.state === 'done') return row
  }
  throw new Error('the import never finished')
}

const stockOf = async (orgId: unknown, productId: unknown, warehouseId: unknown) => Number(((await StockLevel.findOne({ orgId, productId, warehouseId }).lean()) as any)?.quantity ?? 0)

describe('the audited import of a fenced export (FR-20.84)', () => {
  it('brings the sales in as they were, books them on lgrai.app, and leaves the rest for a person', async () => {
    const w = await world()
    await requestFencedImport(w.orgId, String(w.ex._id), { id: String(w.admin._id) })
    const done = await runToEnd(w.ex._id)
    const outcome = async (coll: string, id: unknown) => ((await FencedImportItem.findOne({ exportId: w.ex._id, coll, docKey: String(id) }).lean()) as any)
    // ── kept as it was, with where it came from ──
    const inv: any = await Invoice.collection.findOne({ _id: w.ids.invoice50 } as any)
    expect(inv).toMatchObject({ invoiceNumber: `INV-${year}-00050`, status: 'sent', total: 24, contactId: w.ids.newCustomer })
    expect(inv.importedFrom).toMatchObject({ kind: 'fenced_export', nodeId: NODE, exportId: w.ex._id, moveId: w.ex.moveId })
    expect(String(inv.importedFrom.by)).toBe(String(w.admin._id))
    // The customer it names came with it.
    expect(await db().collection('contacts').findOne({ _id: w.ids.newCustomer })).toMatchObject({ companyName: 'Sold to after the cutoff' })
    // ── booked here: stock, its entry, the payment's entry ──
    const dispatch: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: w.ids.invoice50 }).lean()
    expect(dispatch).toMatchObject({ type: 'dispatch', status: 'completed' })
    expect(String(inv.journalEntryId)).not.toBe(String(w.ids.je))
    expect(await JournalEntry.exists({ _id: inv.journalEntryId })).toBeTruthy()
    const paid: any = await Invoice.collection.findOne({ _id: w.ids.paid52 } as any)
    expect(paid.payments[0].journalEntryId && String(paid.payments[0].journalEntryId) !== String(w.ids.je)).toBe(true)
    expect(await JournalEntry.exists({ _id: paid.payments[0].journalEntryId })).toBeTruthy()
    // 10 − 2 (INV-50) − 1 (INV-52) − 1 (the INV-42 issued twice: the goods left all the same) + 5 (the
    // delivery) = 11; the nut went below zero, as the shelf did.
    expect(await stockOf(w.oid, w.bolt._id, w.wh._id)).toBe(11)
    expect(await stockOf(w.oid, w.ids.newProduct, w.wh._id)).toBe(-3)
    // ── a till sale: its stock here, its session journaled at its close ──
    const cs: any = await Invoice.collection.findOne({ _id: w.ids.cashSale } as any)
    expect(cs.register).toMatchObject({ origin: 'pos', unp: 'ED123456-0001-0000007', fiscal: { state: 'printed' } })
    expect(String(cs.register.movementId)).not.toBe(String(w.ids.saleMovement))
    expect(await StockMovement.exists({ _id: cs.register.movementId, invoiceId: w.ids.cashSale })).toBeTruthy()
    const session: any = await POSSession.findById(w.ids.session).lean()
    expect(session.journalEntryId && String(session.journalEntryId) !== String(w.ids.je)).toBe(true)
    // ── a delivery of its own: confirmed here, under the next number (lgrai.app had used 00007) ──
    const receipt: any = await StockMovement.collection.findOne({ _id: w.ids.receipt } as any)
    expect(receipt.status).toBe('completed')
    expect(receipt.movementNumber).not.toBe(`SM-${year}-00007`)
    expect(receipt.importedFrom.number).toBe(`SM-${year}-00007`)
    // ── a draft whose number lgrai.app used: the next draft number, the site's kept ──
    const draft: any = await Invoice.collection.findOne({ _id: w.ids.draft } as any)
    expect(draft.invoiceNumber).toBe(`DRF-INV-${year}-00004`)
    expect(draft.importedFrom.number).toBe(`DRF-INV-${year}-00003`)
    // ── the document and its file, where the row says; the site's trail ──
    expect(await db().collection('docfiles').findOne({ _id: w.ids.doc })).toBeTruthy()
    expect(sha(readFileSync(join(root, 'global', ...w.rel.split('/'))))).toBe(sha(w.content))
    expect(await AuditLog.exists({ _id: w.ids.audit })).toBeTruthy()
    // ── left for a person, each with why ──
    // AC 51: a number issued twice. Both are on paper, so both are in the books: the site's under its
    // number, flagged with lgrai.app's (the later is corrected by a credit note and a re-issue).
    const clash: any = await Invoice.collection.findOne({ _id: w.ids.clash } as any)
    expect([clash?.invoiceNumber, String(clash?.numberClash?.withId), clash?.numberClash?.source]).toEqual([`INV-${year}-00042`, String(w.ours42), 'fenced_export'])
    expect(await outcome('invoices', w.ids.clash)).toMatchObject({ outcome: 'imported', reason: 'number_clash', number: `INV-${year}-00042` })
    expect(await Invoice.exists({ _id: w.ids.missing })).toBeNull()
    expect(await outcome('invoices', w.ids.missing)).toMatchObject({ outcome: 'skipped', reason: 'missing_reference' })
    expect(await outcome('stockmovements', w.ids.saleMovement)).toMatchObject({ outcome: 'skipped', reason: 'made_by_its_sale' })
    expect(await outcome('journalentries', w.ids.je)).toMatchObject({ outcome: 'skipped', reason: 'not_imported_kind' })
    expect(await outcome('contacts', `deleted:${String(w.ids.gone)}`)).toMatchObject({ outcome: 'skipped', reason: 'deletion' })
    expect(await JournalEntry.exists({ _id: w.ids.je })).toBeNull()
    // ── numbering goes on above what was imported ──
    const seq = async (prefix: string, y = year) => Number(((await Sequence.findOne({ orgId: w.oid, prefix, year: y }).lean()) as any)?.lastNumber ?? 0)
    expect(await seq('SALES_DOC')).toBe(52)
    expect(await seq('CASH_SALE')).toBe(10)
    expect(await seq('UNP-ED123456', 0)).toBe(7)
    // ── done, counted, and the review says what became of each sale ──
    expect(done.import.counts).toMatchObject({ 'imported': expect.any(Number), 'imported:number_clash': 1, 'skipped:missing_reference': 1, 'skipped:made_by_its_sale': 1, 'skipped:not_imported_kind': 1, 'skipped:deletion': 1 })
    const [review] = await fencedExportsOf(w.orgId)
    const by = Object.fromEntries(review.legal.map(l => [l.number, l]))
    expect(by[`INV-${year}-00050`]).toMatchObject({ onGlobal: 'absent', imported: { outcome: 'imported' } })
    expect(by[`INV-${year}-00042`]).toMatchObject({ onGlobal: 'collision', imported: { outcome: 'imported', reason: 'number_clash' } })
    expect(review).toMatchObject({ nodeName: null, import: { state: 'done' } })
    expect(await AuditLog.exists({ orgId: w.oid, entityType: 'fenced_export', action: 'import', entityId: w.ex._id })).toBeTruthy()
  }, 120_000)

  it('a receipt whose request died on the site arrives for a person to settle: its device stayed behind', async () => {
    const w = await world({ deadReceipt: true })
    await requestFencedImport(w.orgId, String(w.ex._id), { id: String(w.admin._id) })
    await runToEnd(w.ex._id)

    const receipt: any = await Invoice.collection.findOne({ _id: w.ids.dead } as any)
    expect(receipt.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    expect(receipt.leaseUntil).toBeUndefined()
    // Its hold came with its invoice, and a person can now see why, and let go of it.
    const held = String(w.ids.held)
    expect(await receiptInDoubt(w.orgId, held)).toMatchObject({ invoiceNumber: `CS-${year}-00011` })
    expect(await freezeRefusal(w.orgId, held)).toMatchObject({ code: 'receipt_in_doubt' })
    const settled = await settleReceipt(deviceless(w.orgId, { id: String(w.admin._id), operatorCode: '0001' } as any), String(w.ids.dead), false)
    expect(settled.status).toBe('voided')
    expect(((await Invoice.collection.findOne({ _id: w.ids.held } as any)) as any).receiptHolds ?? []).toHaveLength(0)
    expect(await freezeRefusal(w.orgId, held)).toBeNull()
  })

  it('repeats nothing when a crash cuts it short, and never twice', async () => {
    const w = await world()
    await requestFencedImport(w.orgId, String(w.ex._id), { id: String(w.admin._id) })
    await runToEnd(w.ex._id)
    const entries = await JournalEntry.countDocuments({ orgId: w.oid })
    const movements = await StockMovement.countDocuments({ orgId: w.oid })
    const bolt = await stockOf(w.oid, w.bolt._id, w.wh._id)
    // A process died after booking INV-50 and before writing its row: the next one takes it as its own.
    await FencedImportItem.deleteOne({ exportId: w.ex._id, coll: 'invoices', docKey: String(w.ids.invoice50) })
    await FencedExport.updateOne({ _id: w.ex._id }, { $set: { 'import.state': 'running', 'import.leaseUntil': null } })
    await runToEnd(w.ex._id)
    expect(await FencedImportItem.findOne({ exportId: w.ex._id, coll: 'invoices', docKey: String(w.ids.invoice50) }).lean()).toMatchObject({ outcome: 'imported' })
    expect(await JournalEntry.countDocuments({ orgId: w.oid })).toBe(entries)
    expect(await StockMovement.countDocuments({ orgId: w.oid })).toBe(movements)
    expect(await stockOf(w.oid, w.bolt._id, w.wh._id)).toBe(bolt)
    // Asked for once.
    expect((await captureRejection(requestFencedImport(w.orgId, String(w.ex._id), { id: String(w.admin._id) })))?.code).toBe('already_imported')
  }, 120_000)

  it('imports only a received export, of its own org', async () => {
    const w = await world()
    await FencedExport.updateOne({ _id: w.ex._id }, { $set: { state: 'refused' } })
    expect((await captureRejection(requestFencedImport(w.orgId, String(w.ex._id), { id: String(w.admin._id) })))?.code).toBe('not_received')
    const other = await createTestOrg({ slug: `fenced-other-${n}` } as any)
    expect((await captureRejection(requestFencedImport(String(other._id), String(w.ex._id), { id: String(w.admin._id) })))?.code).toBe('not_found')
    expect(await fencedImportTick()).toBe(0)
    // Asked for while the org was written here, but it moved to a server since: nothing is written.
    await FencedExport.updateOne({ _id: w.ex._id }, { $set: { state: 'received' } })
    await requestFencedImport(w.orgId, String(w.ex._id), { id: String(w.admin._id) })
    await OrgHome.collection.insertOne({ orgId: w.oid, home: 'master-somewhereelse00', epoch: 3, state: 'active', since: new Date() } as any)
    forgetAllHomes()
    expect(await fencedImportTick()).toBe(0)
    expect(((await FencedExport.findById(w.ex._id).lean()) as any).import.error).toBeTruthy()
    expect(await Invoice.exists({ _id: w.ids.invoice50 })).toBeNull()
    expect(await FencedImportItem.countDocuments({ exportId: w.ex._id })).toBe(0)
  }, 60_000)
})
