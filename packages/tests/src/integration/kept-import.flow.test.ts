import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestAccount, createTestContact, createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AuditLog, FencedImportItem, Invoice, Journal, JournalEntry, NodeState, OrgHome, POSSession, Sequence, StockLevel, StockMovement } from 'db/models'
import { forgetAllHomes } from 'db/home/home'
import { writeMoveBundle } from 'services/biz/move/move-bundle'
import { _keptFile, keptImportTick, keptOf, requestKeptImport } from 'services/biz/move/kept-import.service'
import { serverStatusController } from '../../../portal-api/src/controllers/server-status.controller'

/**
 * What a re-seed kept, brought into the books on the server (FR-20.71, FR-20.51; plan step P3-7g):
 * the issued sales only the kept copy holds, with what they name, kept as they were and booked here;
 * the rest listed for a person. The kept copy is the real one (`writeMoveBundle` of the org as this
 * server held it), and the org is then replaced by "the copy", as a re-seed leaves it.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NODE = 'master-keptimporttest000'
const saved = { role: config.node.role, id: (config.node as any).id, upload: config.upload.dir }
let root = ''
let n = 0

beforeAll(async () => {
  await setupTestDB()
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
}, 60_000)
beforeEach(() => {
  ;(config.node as any).role = 'master'
  ;(config.node as any).id = NODE
  root = mkdtempSync(join(tmpdir(), 'lgr-ki-'))
  ;(config.upload as any).dir = root
  n++
})
afterEach(async () => {
  ;(config.node as any).role = saved.role
  ;(config.node as any).id = saved.id
  ;(config.upload as any).dir = saved.upload
  forgetAllHomes()
  rmSync(root, { recursive: true, force: true })
  await clearCollections()
}, 60_000)

const db = () => mongoose.connection.db as any
const oid = () => new mongoose.Types.ObjectId()
const year = new Date().getFullYear()
const line = (productId: unknown, warehouseId: unknown, quantity: number, unitPrice = 10) => ({
  _id: oid(), productId, warehouseId, description: 'goods', quantity, unit: 'pcs', unitPrice, discount: 0, taxRate: 20,
  taxAmount: +(quantity * unitPrice * 0.2).toFixed(2), lineTotal: +(quantity * unitPrice * 1.2).toFixed(2),
})

/**
 * An org on this server after a re-seed: lgrai.app's copy here, and what this server held before it,
 * kept. `more` adds documents only this server held.
 */
async function world(phase = 'active', more?: (r: any) => { invoices?: any[]; stockmovements?: any[] }) {
  const org = await createTestOrg({ slug: `kept-import-${n}` } as any)
  const orgId = org._id as any
  await OrgHome.collection.insertOne({ orgId, home: NODE, epoch: 1, state: 'active', since: new Date() } as any)
  forgetAllHomes()
  const admin = await createTestUser(orgId, { role: 'admin' } as any)
  const customer = await createTestContact(orgId, { companyName: 'Customer in the copy', type: 'customer' } as any)
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
  // INV-41 is in both, and the copy holds it changed. The copy's INV-42 arrives with the re-seed: this
  // server, its database gone back, gave 42 to another sale (below), and one database never holds both.
  const ours42 = oid()
  const shared41 = oid()
  await db().collection('invoices').insertMany([
    { _id: shared41, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00041`, status: 'sent', issueDate: new Date(), contactId: customer._id, currency: 'EUR', total: 12, subtotal: 10, taxTotal: 2, lines: [], payments: [] },
  ])
  await Sequence.collection.insertMany([{ orgId, prefix: 'SALES_DOC', year, lastNumber: 42 }] as any)

  // ── what only this server held, before the re-seed ──
  const ids = { newCustomer: oid(), lonely: oid(), newProduct: oid(), session: oid(), invoice50: oid(), cashSale: oid(), draft: oid(), clash: oid(), missing: oid(), paid52: oid(), saleMovement: oid(), receipt: oid(), draftMovement: oid(), audit: oid(), payment: oid() }
  const at = new Date()
  await db().collection('contacts').insertMany([
    { _id: ids.newCustomer, orgId, companyName: 'Sold to after the disk went back', type: 'customer', isActive: true },
    { _id: ids.lonely, orgId, companyName: 'Named by nothing', type: 'customer', isActive: true },
  ])
  await db().collection('products').insertOne({ _id: ids.newProduct, orgId, name: 'Nut M8', sku: `NUT-${n}`, sellingPrice: 10, taxRate: 20, isActive: true })
  await db().collection('possessions').insertOne({ _id: ids.session, orgId, sessionNumber: 'POS-2026-000009', status: 'closed', warehouseId: wh._id, cashierId: admin._id, openedAt: at, closedAt: at, openingBalance: 0, closingBalance: 36, totalSales: 36, totalCash: 36 })
  await db().collection('invoices').insertMany([
    { _id: ids.invoice50, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00050`, status: 'sent', issueDate: at, createdAt: at, contactId: ids.newCustomer, currency: 'EUR', exchangeRate: 1, subtotal: 20, taxTotal: 4, total: 24, amountPaid: 0, amountDue: 24, lines: [line(bolt._id, wh._id, 2)], payments: [] },
    {
      _id: ids.cashSale, orgId, type: 'cash_sale', direction: 'outgoing', invoiceNumber: `CS-${year}-00010`, status: 'paid', issueDate: at, currency: 'EUR', exchangeRate: 1, subtotal: 30, taxTotal: 6, total: 36, amountPaid: 36, amountDue: 0,
      lines: [line(ids.newProduct, wh._id, 3)], payments: [{ _id: oid(), method: 'cash', amount: 36, date: at }],
      register: { origin: 'pos', sessionId: ids.session, warehouseId: wh._id, unp: 'ED123456-0001-0000007', fiscal: { mode: 'fiscal', state: 'printed' }, movementId: ids.saleMovement, sessionTotalsApplied: true },
      completedAt: at,
    },
    { _id: ids.draft, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `DRF-INV-${year}-00003`, status: 'draft', issueDate: at, contactId: customer._id, currency: 'EUR', total: 0, lines: [], payments: [] },
    { _id: ids.clash, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00042`, status: 'sent', issueDate: at, contactId: customer._id, currency: 'EUR', total: 12, lines: [line(bolt._id, wh._id, 1)], payments: [] },
    { _id: ids.missing, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00051`, status: 'sent', issueDate: at, contactId: customer._id, currency: 'EUR', total: 12, lines: [line(oid(), wh._id, 1)], payments: [] },
    { _id: ids.paid52, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00052`, status: 'paid', issueDate: at, contactId: customer._id, currency: 'EUR', exchangeRate: 1, subtotal: 10, taxTotal: 2, total: 12, amountPaid: 12, amountDue: 0, lines: [line(bolt._id, wh._id, 1)], payments: [{ _id: ids.payment, method: 'bank_transfer', amount: 12, date: at }] },
  ])
  await db().collection('stockmovements').insertMany([
    { _id: ids.saleMovement, orgId, movementNumber: `SM-${year}-00099`, type: 'dispatch', status: 'completed', date: at, invoiceId: ids.cashSale, lines: [] },
    { _id: ids.receipt, orgId, movementNumber: `SM-${year}-00007`, type: 'receipt', status: 'completed', date: at, toWarehouseId: wh._id, lines: [{ productId: bolt._id, quantity: 5, unitCost: 4, totalCost: 20 }] },
    { _id: ids.draftMovement, orgId, movementNumber: `SM-${year}-00008`, type: 'receipt', status: 'draft', date: at, toWarehouseId: wh._id, lines: [{ productId: bolt._id, quantity: 1, unitCost: 4, totalCost: 4 }] },
  ])
  await db().collection('auditlogs').insertOne({ _id: ids.audit, orgId, userId: admin._id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: ids.invoice50, entityName: `INV-${year}-00050`, timestamp: at })
  const added = more?.({ orgId, wh, bolt, customer, at }) ?? {}
  if (added.invoices?.length) await db().collection('invoices').insertMany(added.invoices)
  if (added.stockmovements?.length) await db().collection('stockmovements').insertMany(added.stockmovements)

  // ── the re-seed: everything kept, then lgrai.app's copy in its place ──
  const moveId = String(oid())
  const file = _keptFile(String(orgId), moveId)
  mkdirSync(dirname(file), { recursive: true })
  const kept = await writeMoveBundle(db(), orgId, file)
  const only: Array<[string, unknown]> = [
    ['contacts', ids.newCustomer], ['contacts', ids.lonely], ['products', ids.newProduct], ['possessions', ids.session],
    ...[ids.invoice50, ids.cashSale, ids.draft, ids.clash, ids.missing, ids.paid52].map(id => ['invoices', id] as [string, unknown]),
    ['stockmovements', ids.saleMovement], ['stockmovements', ids.receipt], ['stockmovements', ids.draftMovement], ['auditlogs', ids.audit],
    ...(added.invoices ?? []).map((d: any) => ['invoices', d._id] as [string, unknown]),
    ...(added.stockmovements ?? []).map((d: any) => ['stockmovements', d._id] as [string, unknown]),
  ]
  for (const [coll, id] of only) await db().collection(coll).deleteOne({ _id: id })
  await db().collection('invoices').insertOne({ _id: ours42, orgId, type: 'invoice', direction: 'outgoing', invoiceNumber: `INV-${year}-00042`, status: 'sent', issueDate: new Date(), contactId: customer._id, currency: 'EUR', total: 12, subtotal: 10, taxTotal: 2, lines: [], payments: [] })
  await db().collection('invoices').updateOne({ _id: shared41 }, { $set: { total: 99 } })
  await NodeState.collection.insertOne({ _id: `move:${moveId}`, value: { phase, at, kept: { file: `docs/reseed/${moveId}.ndjson.zst`, documents: kept.documents, onlyThere: only.length, sales: 5, salesNumbers: [`INV-${year}-00050`] } } } as any)
  return { orgId: String(orgId), oid: orgId, admin, customer, wh, bolt, ids, moveId, shared41 }
}

async function runToEnd(moveId: string) {
  for (let i = 0; i < 5; i++) {
    await keptImportTick()
    const st: any = ((await NodeState.findById(`kept-import:${moveId}`).lean()) as any)?.value
    if (st?.state === 'done') return st
  }
  throw new Error('the kept import never finished')
}
const stockOf = async (orgId: unknown, productId: unknown, warehouseId: unknown) => Number(((await StockLevel.findOne({ orgId, productId, warehouseId }).lean()) as any)?.quantity ?? 0)

describe('what a re-seed kept, brought into the books on the server (FR-20.71, P3-7g)', () => {
  it('the issued sales only the kept copy holds come in as they were, booked here, with what they name; the rest is listed', async () => {
    const w = await world()
    await requestKeptImport(w.orgId, w.moveId, { id: String(w.admin._id) })
    const done = await runToEnd(w.moveId)
    const outcome = async (coll: string, id: unknown) => ((await FencedImportItem.findOne({ exportId: new mongoose.Types.ObjectId(w.moveId), coll, docKey: String(id) }).lean()) as any)
    // ── kept as it was, with where it came from ──
    const inv: any = await Invoice.collection.findOne({ _id: w.ids.invoice50 } as any)
    expect(inv).toMatchObject({ invoiceNumber: `INV-${year}-00050`, status: 'sent', total: 24, contactId: w.ids.newCustomer })
    expect(inv.importedFrom).toMatchObject({ kind: 'reseed_kept', nodeId: NODE })
    expect([String(inv.importedFrom.moveId), String(inv.importedFrom.by)]).toEqual([w.moveId, String(w.admin._id)])
    // What it names came with it; what nothing names did not.
    expect(await db().collection('contacts').findOne({ _id: w.ids.newCustomer })).toMatchObject({ companyName: 'Sold to after the disk went back' })
    expect(await db().collection('contacts').findOne({ _id: w.ids.lonely })).toBeNull()
    // ── booked here: stock, its entry, the payment's entry ──
    expect(await StockMovement.findOne({ orgId: w.oid, invoiceId: w.ids.invoice50 }).lean()).toMatchObject({ type: 'dispatch', status: 'completed' })
    expect(await JournalEntry.exists({ _id: inv.journalEntryId })).toBeTruthy()
    const paid: any = await Invoice.collection.findOne({ _id: w.ids.paid52 } as any)
    expect(await JournalEntry.exists({ _id: paid.payments[0].journalEntryId })).toBeTruthy()
    // 10 − 2 (INV-50) − 1 (INV-52) − 1 (the INV-42 issued twice) + 5 (the delivery) = 11; the nut
    // below zero, as the shelf went.
    expect(await stockOf(w.oid, w.bolt._id, w.wh._id)).toBe(11)
    expect(await stockOf(w.oid, w.ids.newProduct, w.wh._id)).toBe(-3)
    // ── a till sale: its stock here, its session journaled at its close ──
    const cs: any = await Invoice.collection.findOne({ _id: w.ids.cashSale } as any)
    expect(String(cs.register.movementId)).not.toBe(String(w.ids.saleMovement))
    expect(await StockMovement.exists({ _id: cs.register.movementId, invoiceId: w.ids.cashSale })).toBeTruthy()
    expect(((await POSSession.findById(w.ids.session).lean()) as any)?.journalEntryId).toBeTruthy()
    // ── a delivery of its own: confirmed here ──
    expect(((await StockMovement.collection.findOne({ _id: w.ids.receipt } as any)) as any)?.status).toBe('completed')
    // ── never overwritten: the copy's INV-41 stays the copy's ──
    expect(((await Invoice.collection.findOne({ _id: w.shared41 } as any)) as any)?.total).toBe(99)
    // ── left for a person, each with why ──
    // AC 51: the kept INV-42 and the copy's are both in the books, the kept one flagged.
    const clash: any = await Invoice.collection.findOne({ _id: w.ids.clash } as any)
    expect([clash?.invoiceNumber, clash?.numberClash?.source]).toEqual([`INV-${year}-00042`, 'reseed_kept'])
    expect(await outcome('invoices', w.ids.clash)).toMatchObject({ outcome: 'imported', reason: 'number_clash', number: `INV-${year}-00042` })
    expect(await outcome('invoices', w.ids.missing)).toMatchObject({ outcome: 'skipped', reason: 'missing_reference' })
    expect(await outcome('invoices', w.ids.draft)).toMatchObject({ outcome: 'skipped', reason: 'kept_draft', number: `DRF-INV-${year}-00003` })
    expect(await outcome('stockmovements', w.ids.draftMovement)).toMatchObject({ outcome: 'skipped', reason: 'kept_draft' })
    expect(await Invoice.exists({ _id: w.ids.draft })).toBeNull()
    expect(await StockMovement.exists({ _id: w.ids.draftMovement })).toBeNull()
    expect(done.keptOnly).toMatchObject({ contacts: 1, auditlogs: 1 })
    expect(await AuditLog.exists({ _id: w.ids.audit })).toBeNull()
    // ── numbering goes on above what came in ──
    const seq = async (prefix: string, y = year) => Number(((await Sequence.findOne({ orgId: w.oid, prefix, year: y }).lean()) as any)?.lastNumber ?? 0)
    expect(await seq('SALES_DOC')).toBe(52)
    expect(await seq('UNP-ED123456', 0)).toBe(7)
    expect(done.counts).toMatchObject({ 'imported:number_clash': 1, 'skipped:missing_reference': 1, 'skipped:kept_draft': 2 })
    expect(done.counts.imported).toBe(7)
    // ── the page's account of it ──
    const [run] = await keptOf(w.orgId)
    expect(run).toMatchObject({ moveId: w.moveId, done: true, import: { state: 'done' } })
    expect(run.left.map((l: any) => l.reason).sort()).toEqual(['kept_draft', 'kept_draft', 'missing_reference'])
    expect(await AuditLog.exists({ orgId: w.oid, entityType: 'org_move', action: 'import', entityId: new mongoose.Types.ObjectId(w.moveId) })).toBeTruthy()
  }, 120_000)

  it('a receipt its bill lists comes in with its goods, also when the bill is a draft left for a person (#168)', async () => {
    const claimed = oid()
    const claimedByDraft = oid()
    const billId = oid()
    const draftBill = oid()
    const ownReceipt = oid()
    const ownBill = oid()
    const w = await world('active', ({ orgId, wh, bolt, customer, at }) => {
      const bill = (id: unknown, number: string, status: string, rest: any) => ({
        _id: id, orgId, type: 'invoice', direction: 'incoming', invoiceNumber: number, status, issueDate: at, contactId: customer._id, currency: 'EUR', exchangeRate: 1,
        subtotal: 10, taxTotal: 2, total: 12, amountPaid: 0, amountDue: 12, payments: [], lines: [line(bolt._id, wh._id, 7)], ...rest,
      })
      const link = (id: unknown) => ({ stockSource: { marker: `movement:${id}`, docNumber: 'SM', movementIds: [id], detectedBy: 'manual', linkedAt: at } })
      const delivery = (id: unknown, number: string, quantity: number, invoiceId: unknown) => ({
        _id: id, orgId, movementNumber: number, type: 'receipt', status: 'completed', date: at, toWarehouseId: wh._id, contactId: customer._id, invoiceId,
        lines: [{ productId: bolt._id, quantity, unitCost: 1, totalCost: quantity }],
      })
      return {
        invoices: [
          bill(billId, `BILL-${year}-00061`, 'received', link(claimed)),
          bill(draftBill, `DRF-BILL-${year}-00062`, 'draft', link(claimedByDraft)),
          bill(ownBill, `BILL-${year}-00063`, 'received', { lines: [line(bolt._id, wh._id, 20)] }),
        ],
        stockmovements: [
          delivery(claimed, `SM-${year}-00061`, 7, billId),
          delivery(claimedByDraft, `SM-${year}-00062`, 30, draftBill),
          delivery(ownReceipt, `SM-${year}-00063`, 20, ownBill),
        ],
      }
    })
    await requestKeptImport(w.orgId, w.moveId, { id: String(w.admin._id) })
    await runToEnd(w.moveId)

    // 11 as in the test above, + 7 and 30 (the two listed) + 20 (the bill's own, booked by its import).
    expect(await stockOf(w.oid, w.bolt._id, w.wh._id)).toBe(68)
    const kept: any = await StockMovement.collection.findOne({ _id: claimed } as any)
    expect(kept.status).toBe('completed')
    expect(String(kept.invoiceId)).toBe(String(billId))
    const byDraft: any = await StockMovement.collection.findOne({ _id: claimedByDraft } as any)
    expect(byDraft.status).toBe('completed')
    expect(await Invoice.exists({ _id: draftBill })).toBeNull()
    expect(await StockMovement.exists({ _id: ownReceipt })).toBeNull()
  }, 120_000)

  it('repeats nothing when a crash cuts it short, and is asked for once', async () => {
    const w = await world()
    await requestKeptImport(w.orgId, w.moveId, { id: String(w.admin._id) })
    await runToEnd(w.moveId)
    const entries = await JournalEntry.countDocuments({ orgId: w.oid })
    const movements = await StockMovement.countDocuments({ orgId: w.oid })
    const bolt = await stockOf(w.oid, w.bolt._id, w.wh._id)
    // A process died after booking INV-50 and before writing its row: the next run takes it as its own.
    await FencedImportItem.deleteOne({ exportId: new mongoose.Types.ObjectId(w.moveId), coll: 'invoices', docKey: String(w.ids.invoice50) })
    await NodeState.updateOne({ _id: `kept-import:${w.moveId}` }, { $set: { 'value.state': 'running', 'value.leaseUntil': null } })
    await runToEnd(w.moveId)
    expect(await FencedImportItem.findOne({ exportId: new mongoose.Types.ObjectId(w.moveId), coll: 'invoices', docKey: String(w.ids.invoice50) }).lean()).toMatchObject({ outcome: 'imported' })
    expect([await JournalEntry.countDocuments({ orgId: w.oid }), await StockMovement.countDocuments({ orgId: w.oid }), await stockOf(w.oid, w.bolt._id, w.wh._id)]).toEqual([entries, movements, bolt])
    expect((await captureRejection(requestKeptImport(w.orgId, w.moveId, { id: String(w.admin._id) })))?.code).toBe('already_imported')
  }, 120_000)

  it('only for a re-seed that finished, of a kept copy of this org on this server', async () => {
    const w = await world('unfrozen')
    expect((await captureRejection(requestKeptImport(w.orgId, w.moveId, { id: String(w.admin._id) })))?.code).toBe('not_reseeded')
    expect((await captureRejection(requestKeptImport(w.orgId, String(oid()), { id: String(w.admin._id) })))?.code).toBe('not_found')
    const other = await createTestOrg({ slug: `kept-other-${n}` } as any)
    expect((await captureRejection(requestKeptImport(String(other._id), w.moveId, { id: String(w.admin._id) })))?.code).toBe('not_found')
    expect(await keptImportTick()).toBe(0)
    // The page lists it, with nothing to bring in.
    expect((await keptOf(w.orgId))[0]).toMatchObject({ moveId: w.moveId, done: false, import: null })
  }, 120_000)

  it('the routes: the org\'s admins on its server; a member 403; lgrai.app 404', async () => {
    const w = await world()
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
    const app = new Elysia().use(serverStatusController)
    const member = await createTestUser(w.oid, { email: 'member@kept.test', role: 'member' } as any)
    const token = async (u: any, role: string) => (signer as any).decorator.jwt.sign({ id: String(u._id), orgId: w.orgId, role, email: `${role}@kept.test`, username: role, permissions: [] })
    const call = async (method: string, path: string, t: string) => {
      const res = await app.handle(new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${t}` } }))
      return { status: res.status, json: await res.json().catch(() => null) as any }
    }
    const admin = await token(w.admin, 'admin')
    const listed = await call('GET', `/org/${w.orgId}/server/kept`, admin)
    expect([listed.status, listed.json.kept[0]?.moveId, listed.json.kept[0]?.kept?.onlyThere]).toEqual([200, w.moveId, 14])
    expect((await call('POST', `/org/${w.orgId}/server/kept/${w.moveId}/import`, await token(member, 'member'))).status).toBe(403)
    const asked = await call('POST', `/org/${w.orgId}/server/kept/${w.moveId}/import`, admin)
    expect([asked.status, asked.json.import.state]).toEqual([200, 'requested'])
    expect((await call('POST', `/org/${w.orgId}/server/kept/${w.moveId}/import`, admin)).json.code).toBe('already_imported')
    ;(config.node as any).role = 'global'
    await OrgHome.deleteMany({}).exec()
    forgetAllHomes()
    expect((await call('GET', `/org/${w.orgId}/server/kept`, admin)).status).toBe(404)
  }, 120_000)
})
