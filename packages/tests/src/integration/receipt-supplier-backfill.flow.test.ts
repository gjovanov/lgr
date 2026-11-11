import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mongoose } from 'db/connection'
import { AuditLog, DocFile, StockMovement } from 'db/models'
import { deliveryNote, movementMarker, reconcileNote, removalReversalNote } from 'config/movement-notes'
import { getSupplierFacts } from 'services/biz/product-suppliers.service'
import { unmatchedPartnerWarning } from 'services/biz/doc-import/supplier-name'
import { matchSupplierByName } from 'services/biz/doc-import/matching'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestStockMovement, createTestUser, createTestWarehouse } from '../helpers/factories'
import {
  applyReceiptSupplier, collectPartners, countUndoable, planReceiptSupplierBackfill, receiptDocumentNumber, undoReceiptSupplier,
} from '../../../../scripts/lib/receipt-supplier-backfill'

/**
 * FR-28.12 for the receipts booked before it (`scripts/backfill-receipt-suppliers.ts`): a receipt that names no
 * supplier takes the one its own document names, by the importers' rule, and nothing else about it changes. Made-up
 * partners throughout.
 */

const id = () => new mongoose.Types.ObjectId()
const REASON = 'test run'

let org: any, other: any, owner: any, warehouse: any
const supplier: Record<string, any> = {}
const product: Record<string, any> = {}
const r: Record<string, any> = {}
let seq = 0
let markers = 0

async function receipt(key: string, productKey: string, extra: Record<string, unknown> = {}, orgId: any = org._id) {
  const p = product[productKey]
  // One a day, in the order they are made: the plan reads them oldest first.
  r[key] = await createTestStockMovement(orgId, {
    movementNumber: `SM-2026-${String(++seq).padStart(5, '0')}`, type: 'receipt', status: 'completed', date: new Date(Date.UTC(2026, 7, seq)),
    toWarehouseId: warehouse._id, createdBy: owner._id,
    lines: [{ productId: p._id, quantity: 4, unitCost: 2.5, totalCost: 10 }], totalAmount: 10,
    ...extra,
  } as any)
  return r[key]
}

const docFor = (movement: any, warnings: string[], orgId: any = org._id) => DocFile.create({
  orgId, docType: 'goods_receipt', docNumber: `30000${String(movement._id).slice(-5)}`, docDate: '2026-08-01',
  originalName: 'stokrazp_test.pdf', currentPath: '/nowhere/stokrazp_test.pdf', currentChecksum: String(id()), mimeType: 'application/pdf', size: 1,
  status: 'committed', committedTarget: 'movement', committedIds: [movement._id], uploadedBy: owner._id,
  analysis: { target: 'movement', diagnostics: { perLine: [], warnings } },
})

const fresh = async (key: string) => (await StockMovement.findById(r[key]._id).lean().exec()) as any
const note = (partner?: string, kind = 'goods_receipt') => deliveryNote('2026-08-01', movementMarker(kind, String(3000000000 + ++markers)), partner)

beforeAll(async () => {
  await setupTestDB()
  org = await createTestOrg({ name: 'Склад Тест', slug: 'receipt-supplier-backfill-test' } as any)
  other = await createTestOrg({ name: 'Друг', slug: 'receipt-supplier-backfill-other' } as any)
  owner = await createTestUser(org._id)
  warehouse = await createTestWarehouse(org._id)

  supplier.alfa = await createTestContact(org._id, { type: 'supplier', companyName: 'АЛФА ТЕСТ ЕООД' } as any)
  supplier.beta = await createTestContact(org._id, { type: 'both', companyName: 'Бета  Тест   ООД' } as any)
  supplier.twinA = await createTestContact(org._id, { type: 'supplier', companyName: 'ДВОЙНИК ООД' } as any)
  supplier.twinB = await createTestContact(org._id, { type: 'supplier', companyName: 'двойник ООД' } as any)
  supplier.customer = await createTestContact(org._id, { type: 'customer', companyName: 'САМО КЛИЕНТ ЕООД' } as any)
  supplier.gone = await createTestContact(org._id, { type: 'supplier', companyName: 'СПРЯН ДОСТАВЧИК ООД', isActive: false } as any)
  // The same name in another organization must never be read.
  supplier.foreign = await createTestContact(other._id, { type: 'supplier', companyName: 'ЧУЖД ДОСТАВЧИК ООД' } as any)

  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) product[k] = await createTestProduct(org._id)

  // Named by their notes, as the API importers wrote them.
  await receipt('prefixed', 'a', { notes: note('ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД') })
  await receipt('bareOtherCase', 'b', { notes: note('  бета тест ООД ') })
  // Named by the document that booked them: the Files import left the name in its analysis.
  await receipt('fromDocument', 'c', { notes: note() })
  await docFor(r.fromDocument, ['line 2: a new product', unmatchedPartnerWarning('Алфа Тест ЕООД')])
  // The notes win over the document when both name someone.
  await receipt('notesWin', 'd', { notes: note('ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД') })
  await docFor(r.notesWin, [unmatchedPartnerWarning('БЕТА ТЕСТ ООД')])

  // Left alone, each for its own reason.
  await receipt('named', 'a', { notes: note('ПАРТНЬОРИ:БЕТА ТЕСТ ООД'), contactId: supplier.alfa._id })
  await receipt('correction', 'a', { notes: `Корекция от стокова разписка — 2026-08-01 (${movementMarker('correction', '77')})` })
  await receipt('correctionPartner', 'a', { notes: note('ПАРТНЬОРИ:2000 КОРЕКЦИЯ') })
  await receipt('dayAggregate', 'a', { notes: note(undefined, 'store_operations') })
  await receipt('reconcile', 'a', { notes: reconcileNote('stokrazp_1.pdf', 2, 'reconcile:1-v2') })
  await receipt('removalMirror', 'a', { notes: removalReversalNote('SM-2026-00001', '0000000777') })
  await receipt('rolledBack', 'a', { notes: note('ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД'), reversedBy: id(), reversedAt: new Date() })
  await receipt('recordOnly', 'a', { notes: note('ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД'), recordOnly: true })
  await receipt('held', 'a', { notes: note('ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД'), invoiceId: id() })
  await receipt('nobody', 'e', { notes: note() })
  await receipt('freeText', 'e', { notes: 'получено на ръка' })
  await receipt('draft', 'a', { notes: note('ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД'), status: 'draft' })
  await receipt('transfer', 'a', { notes: note('ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД'), type: 'transfer', fromWarehouseId: warehouse._id })

  // Named, and the name is nobody's: reported, never guessed.
  await receipt('unknown1', 'f', { notes: note('ПАРТНЬОРИ:НЯМА ТАКЪВ ООД') })
  await receipt('unknown2', 'f', { notes: note('няма  такъв ООД') })
  await receipt('ambiguous', 'f', { notes: note('ПАРТНЬОРИ:ДВОЙНИК ООД') })
  await receipt('customerOnly', 'f', { notes: note('ПАРТНЬОРИ:САМО КЛИЕНТ ЕООД') })
  await receipt('deactivated', 'f', { notes: note('ПАРТНЬОРИ:СПРЯН ДОСТАВЧИК ООД') })
  await receipt('foreignName', 'f', { notes: note('ПАРТНЬОРИ:ЧУЖД ДОСТАВЧИК ООД') })
  await receipt('ownStore', 'f', { notes: note() })
  await docFor(r.ownStore, [unmatchedPartnerWarning('склад 2')])

  // Another organization's receipt, named by a supplier of ITS own: this run never sees it.
  await receipt('foreign', 'a', { notes: note('ПАРТНЬОРИ:ЧУЖД ДОСТАВЧИК ООД') }, other._id)
})

afterAll(async () => { await teardownTestDB() })

describe('the plan', () => {
  it('names a receipt by its notes or by its document, with the importers\' rule', async () => {
    const { plans } = await planReceiptSupplierBackfill(String(org._id))
    const by = new Map(plans.map(p => [p.movementId, p]))
    expect(plans.length).toBe(4)
    expect(by.get(String(r.prefixed._id))).toMatchObject({ contactId: String(supplier.alfa._id), supplierName: 'АЛФА ТЕСТ ЕООД', source: 'notes', movementNumber: r.prefixed.movementNumber })
    // Another case and other whitespace are the same name; type `both` is a supplier.
    expect(by.get(String(r.bareOtherCase._id))).toMatchObject({ contactId: String(supplier.beta._id), source: 'notes' })
    expect(by.get(String(r.fromDocument._id))).toMatchObject({ contactId: String(supplier.alfa._id), source: 'document' })
    expect(by.get(String(r.notesWin._id))).toMatchObject({ contactId: String(supplier.alfa._id), source: 'notes' })
  })

  it('counts what it leaves alone, and every receipt that names nobody is in exactly one count', async () => {
    const { counts } = await planReceiptSupplierBackfill(String(org._id))
    expect(counts).toEqual({
      receipts: 21, // every completed receipt of this org but `named`
      notCounted: 2, // rolledBack, recordOnly
      notADelivery: 5, // correction, correctionPartner, dayAggregate, reconcile, removalMirror
      heldByADocument: 1,
      noPartnerKnown: 2, // nobody, freeText
      unresolved: 7,
      resolved: 4,
    })
    const { receipts, ...parts } = counts
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(receipts)
  })

  it('reports a name that is nobody\'s, once, with its receipts and why it missed', async () => {
    const { unresolved } = await planReceiptSupplierBackfill(String(org._id))
    const by = new Map(unresolved.map(u => [u.name.toLocaleLowerCase('bg').replace(/\s+/g, ' '), u]))
    expect(unresolved.length).toBe(6)
    // Two receipts, one name: the one on most receipts is first.
    expect(unresolved[0]).toMatchObject({ reason: 'none', receipts: [r.unknown1.movementNumber, r.unknown2.movementNumber] })
    expect(unresolved[0].heldBy).toBeUndefined()
    expect(by.get('двойник оод')).toMatchObject({ reason: 'ambiguous', candidates: 2, receipts: [r.ambiguous.movementNumber] })
    expect(by.get('само клиент еоод')).toMatchObject({ reason: 'none', heldBy: 'customer' })
    expect(by.get('спрян доставчик оод')).toMatchObject({ reason: 'none', heldBy: 'deactivated supplier' })
    // A supplier of another organization is nobody here.
    expect(by.get('чужд доставчик оод')).toMatchObject({ reason: 'none', receipts: [r.foreignName.movementNumber] })
    expect(by.get('чужд доставчик оод')!.heldBy).toBeUndefined()
    expect(by.get('склад 2')).toMatchObject({ reason: 'none', receipts: [r.ownStore.movementNumber] })
  })

  it('reads only: a plan changes nothing', async () => {
    const before = await StockMovement.find({}).sort({ _id: 1 }).lean().exec()
    await planReceiptSupplierBackfill(String(org._id))
    expect(await StockMovement.find({}).sort({ _id: 1 }).lean().exec()).toEqual(before)
    expect(await AuditLog.countDocuments({ entityType: 'stock_movement' })).toBe(0)
  })
})

describe('the run', () => {
  it('before it, the articles have no supplier', async () => {
    const facts = await getSupplierFacts(String(org._id), [String(product.b._id), String(product.c._id)])
    expect(facts[String(product.b._id)]).toEqual([])
    expect(facts[String(product.c._id)]).toEqual([])
  })

  it('writes the supplier and nothing else, with an audit entry on the receipt', async () => {
    const { plans } = await planReceiptSupplierBackfill(String(org._id))
    const untouched = await StockMovement.find({ _id: { $nin: plans.map(p => p.movementId) } }).sort({ _id: 1 }).lean().exec()
    const was = await fresh('bareOtherCase')

    for (const p of plans) expect(await applyReceiptSupplier(String(org._id), p, owner._id, REASON)).toBe(true)

    const now = await fresh('bareOtherCase')
    expect(String(now.contactId)).toBe(String(supplier.beta._id))
    const { contactId: _c, updatedAt: _u, ...rest } = now
    const { updatedAt: _w, ...restWas } = was
    expect(rest).toEqual(restWas)
    expect(String((await fresh('prefixed')).contactId)).toBe(String(supplier.alfa._id))
    expect(String((await fresh('fromDocument')).contactId)).toBe(String(supplier.alfa._id))
    expect(String((await fresh('notesWin')).contactId)).toBe(String(supplier.alfa._id))
    // Every other movement of every organization is as it was, byte for byte.
    expect(await StockMovement.find({ _id: { $nin: plans.map(p => p.movementId) } }).sort({ _id: 1 }).lean().exec()).toEqual(untouched)

    const audits = await AuditLog.find({ orgId: org._id, entityType: 'stock_movement' }).lean().exec() as any[]
    expect(audits.length).toBe(4)
    const one = audits.find(a => String(a.entityId) === String(r.prefixed._id))
    expect(one).toMatchObject({ action: 'update', module: 'warehouse', entityName: r.prefixed.movementNumber })
    expect(String(one.userId)).toBe(String(owner._id))
    expect(one.changes).toEqual([
      expect.objectContaining({ field: 'contactId', oldValue: null, newValue: String(supplier.alfa._id) }),
      expect.objectContaining({ field: 'reason', newValue: REASON }),
    ])
  })

  it('after it, the supplier facts name who the article came from', async () => {
    const facts = await getSupplierFacts(String(org._id), [String(product.b._id), String(product.c._id), String(product.f._id)])
    expect(facts[String(product.b._id)].map(f => f.supplierId)).toEqual([String(supplier.beta._id)])
    expect(facts[String(product.c._id)].map(f => f.supplierId)).toEqual([String(supplier.alfa._id)])
    // The unresolved ones brought in `f`: still nobody's.
    expect(facts[String(product.f._id)]).toEqual([])
  })

  it('a second run finds nothing to write', async () => {
    const { plans, counts } = await planReceiptSupplierBackfill(String(org._id))
    expect(plans).toEqual([])
    expect(counts.receipts).toBe(17)
    expect(counts.unresolved).toBe(7)
  })

  it('a supplier added afterwards is picked up by the next run, and only its receipts', async () => {
    const added = await createTestContact(org._id, { type: 'supplier', companyName: 'Няма Такъв ООД' } as any)
    const { plans, unresolved } = await planReceiptSupplierBackfill(String(org._id))
    expect(plans.map(p => p.movementNumber)).toEqual([r.unknown1.movementNumber, r.unknown2.movementNumber])
    expect(plans.every(p => p.contactId === String(added._id))).toBe(true)
    expect(unresolved.length).toBe(5)
    // Leave them for the race test below.
  })

  it('leaves a receipt that changed after the plan: named by a person, or claimed by a bill', async () => {
    const { plans } = await planReceiptSupplierBackfill(String(org._id))
    const [first, second] = plans
    await StockMovement.updateOne({ _id: first.movementId }, { $set: { contactId: supplier.beta._id } })
    const bill = id()
    await StockMovement.updateOne({ _id: second.movementId }, { $set: { invoiceId: bill, contactId: supplier.twinA._id } })
    const audits = await AuditLog.countDocuments({ entityType: 'stock_movement' })

    expect(await applyReceiptSupplier(String(org._id), first, owner._id, REASON)).toBe(false)
    expect(await applyReceiptSupplier(String(org._id), second, owner._id, REASON)).toBe(false)
    expect(String((await fresh('unknown1')).contactId)).toBe(String(supplier.beta._id))
    expect(String((await fresh('unknown2')).contactId)).toBe(String(supplier.twinA._id))
    expect(String((await fresh('unknown2')).invoiceId)).toBe(String(bill))
    expect(await AuditLog.countDocuments({ entityType: 'stock_movement' })).toBe(audits)
  })

  it('never writes across organizations: the same id under another org changes nothing', async () => {
    const plan = { movementId: String(r.foreign._id), movementNumber: r.foreign.movementNumber, contactId: String(supplier.alfa._id), supplierName: 'x', source: 'notes' as const }
    expect(await applyReceiptSupplier(String(org._id), plan, owner._id, REASON)).toBe(false)
    expect((await StockMovement.findById(r.foreign._id).lean().exec() as any).contactId).toBeUndefined()
  })
})

describe('the way back', () => {
  const entry = (key: string, contact: any) => ({ movementId: String(r[key]._id), movementNumber: r[key].movementNumber, contactId: String(contact._id) })

  it('takes back what the run wrote, and only while the receipt is still as the run left it', async () => {
    // `notesWin` was billed since; a person gave `fromDocument` another supplier.
    await StockMovement.updateOne({ _id: r.notesWin._id }, { $set: { invoiceId: id() } })
    await StockMovement.updateOne({ _id: r.fromDocument._id }, { $set: { contactId: supplier.beta._id } })
    const entries = [entry('prefixed', supplier.alfa), entry('bareOtherCase', supplier.beta), entry('fromDocument', supplier.alfa), entry('notesWin', supplier.alfa)]
    expect(await countUndoable(String(org._id), entries)).toBe(2)

    const done: boolean[] = []
    for (const e of entries) done.push(await undoReceiptSupplier(String(org._id), e, owner._id, 'taken back'))
    expect(done).toEqual([true, true, false, false])

    expect((await fresh('prefixed')).contactId).toBeUndefined()
    expect((await fresh('bareOtherCase')).contactId).toBeUndefined()
    expect(String((await fresh('fromDocument')).contactId)).toBe(String(supplier.beta._id))
    expect(String((await fresh('notesWin')).contactId)).toBe(String(supplier.alfa._id))

    const back = await AuditLog.find({ orgId: org._id, entityType: 'stock_movement', entityId: r.prefixed._id }).sort({ _id: 1 }).lean().exec() as any[]
    expect(back.length).toBe(2)
    expect(back[1].changes[0]).toMatchObject({ field: 'contactId', oldValue: String(supplier.alfa._id), newValue: null })
    expect(await countUndoable(String(org._id), entries)).toBe(0)
  })

  it('a receipt it gave back is one the next run names again', async () => {
    const { plans } = await planReceiptSupplierBackfill(String(org._id))
    expect(plans.map(p => p.movementNumber).sort()).toEqual([r.prefixed.movementNumber, r.bareOtherCase.movementNumber].sort())
  })
})

/**
 * A receipt booked before the importers recorded a partner keeps none: not in its notes, not in its document. The
 * source still has it, by the number of the document, and the receipt says which document it is.
 */
describe('receipts that keep no partner of their own', () => {
  let third: any, alfa: any
  const q: Record<string, any> = {}
  const HEADER = 'N                       Име                      М     Ко     Це    Про    Це'
  const partners = {
    '3000000101': 'ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД',
    '3000000102': 'ПАРТНЬОРИ:Алфа  Тест ЕООД',
    '103': 'ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД',
    '3000000104': '',
    '3000000106': 'ПАРТНЬОРИ:НИКОЙ ООД',
    '3000000107': 'ПАРТНЬОРИ:2000 КОРЕКЦИЯ',
    '3000000109': 'ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД',
    '3000000110': 'ПАРТНЬОРИ:НИКОЙ ООД',
  }

  beforeAll(async () => {
    third = await createTestOrg({ name: 'Трети', slug: 'receipt-supplier-backfill-given' } as any)
    alfa = await createTestContact(third._id, { type: 'supplier', companyName: 'АЛФА ТЕСТ ЕООД' } as any)
    const article = await createTestProduct(third._id)
    let day = 0
    const make = async (key: string, extra: Record<string, unknown>) => {
      q[key] = await createTestStockMovement(third._id, {
        movementNumber: `SM-G-${key}`, type: 'receipt', status: 'completed', date: new Date(Date.UTC(2026, 6, ++day)),
        toWarehouseId: warehouse._id, createdBy: owner._id,
        lines: [{ productId: article._id, quantity: 1, unitCost: 1, totalCost: 1 }], totalAmount: 1, ...extra,
      } as any)
    }
    const plain = (number: string) => deliveryNote('2026-07-01', movementMarker('goods_receipt', number))
    await make('byMarker', { notes: plain('3000000101') })
    await make('byReference', { notes: 'получено на ръка', reference: 'stokrazp_3000000102' })
    await make('padded', { notes: plain('0000000103') })
    await make('sourceNamesNobody', { notes: plain('3000000104') })
    await make('notAsked', { notes: plain('3000000105') })
    await make('unknownGiven', { notes: plain('3000000106') })
    await make('correctionGiven', { notes: plain('3000000107') })
    await make('headerAsName', { notes: plain('3000000108') })
    await docFor(q.headerAsName, [unmatchedPartnerWarning(HEADER)], third._id)
    await make('headerButGiven', { notes: plain('3000000109') })
    await docFor(q.headerButGiven, [unmatchedPartnerWarning(HEADER)], third._id)
    await make('notesWin', { notes: deliveryNote('2026-07-01', movementMarker('goods_receipt', '3000000110'), 'ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД') })
  })

  it('reads which document a receipt is from its marker, else from its reference', () => {
    expect(receiptDocumentNumber({ notes: deliveryNote('2026-07-01', 'stokrazp:3000000101', 'ПАРТНЬОРИ:X') })).toBe('3000000101')
    expect(receiptDocumentNumber({ notes: 'Доставки — 2026-07-01 (stokrazp:0000000103)' })).toBe('103')
    expect(receiptDocumentNumber({ notes: 'получено', reference: ' stokrazp_3000000102 ' })).toBe('3000000102')
    // A correction, a transfer and a day of deliveries are other documents.
    for (const notes of ['Корекция — 2026-07-01 (corr:1)', 'Прехвърляне — 2026-07-01 (sklrazp:12)', 'Доставки — 2026-07-01 (storeOperations:2026-07-01)', '', undefined]) {
      expect(receiptDocumentNumber({ notes })).toBeUndefined()
    }
    expect(receiptDocumentNumber({ notes: 'x', reference: 'sklrazp_0000000012' })).toBeUndefined()
  })

  it('without the source they name nobody, and a table header stored as a name is nobody too', async () => {
    const { counts, plans, unresolved } = await planReceiptSupplierBackfill(String(third._id))
    expect(plans.map(p => [p.movementNumber, p.source])).toEqual([['SM-G-notesWin', 'notes']])
    expect(unresolved).toEqual([])
    expect(counts).toMatchObject({ receipts: 10, noPartnerKnown: 9, unresolved: 0, resolved: 1, notADelivery: 0 })
  })

  it('with the partner the source holds for each document, they name their supplier', async () => {
    const { counts, plans, unresolved } = await planReceiptSupplierBackfill(String(third._id), { partners })
    expect(plans.map(p => [p.movementNumber, p.source])).toEqual([
      ['SM-G-byMarker', 'given'], ['SM-G-byReference', 'given'], ['SM-G-padded', 'given'], ['SM-G-headerButGiven', 'given'],
      // Its own notes name its supplier: what the source says of that document is not asked.
      ['SM-G-notesWin', 'notes'],
    ])
    expect(plans.every(p => p.contactId === String(alfa._id))).toBe(true)
    expect(unresolved).toEqual([{ name: 'НИКОЙ ООД', reason: 'none', receipts: ['SM-G-unknownGiven'] }])
    expect(counts).toEqual({
      receipts: 10, notCounted: 0, heldByADocument: 0,
      notADelivery: 1, // the source says it is a КОРЕКЦИЯ
      noPartnerKnown: 3, // the source names nobody; the source was not asked about it; a header and no source
      unresolved: 1, resolved: 5,
    })
  })

  it('writes them like any other, and the next run has nothing left of them', async () => {
    const { plans } = await planReceiptSupplierBackfill(String(third._id), { partners })
    for (const p of plans) expect(await applyReceiptSupplier(String(third._id), p, owner._id, REASON)).toBe(true)
    for (const key of ['byMarker', 'byReference', 'padded', 'headerButGiven', 'notesWin']) {
      expect(String((await StockMovement.findById(q[key]._id).lean().exec() as any).contactId)).toBe(String(alfa._id))
    }
    for (const key of ['sourceNamesNobody', 'notAsked', 'unknownGiven', 'correctionGiven', 'headerAsName']) {
      expect((await StockMovement.findById(q[key]._id).lean().exec() as any).contactId).toBeUndefined()
    }
    const again = await planReceiptSupplierBackfill(String(third._id), { partners })
    expect(again.plans).toEqual([])
    expect(again.counts.receipts).toBe(5)
  })

  it('collects the partner of each pulled document by its number, and says when a document names nobody', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lgr-partners-'))
    try {
      mkdirSync(join(dir, 'api'))
      writeFileSync(join(dir, 'stokrazp_3000000101.json'), JSON.stringify({ num: '3000000101', header: { docNumber: '3000000101', partner: 'ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД' }, lines: [] }))
      writeFileSync(join(dir, 'api', 'stokrazp_3000000104.json'), JSON.stringify({ header: { docNumber: '3000000104' }, lines: [] }))
      writeFileSync(join(dir, 'api', 'stokrazp_0000000103.json'), '\uFEFF' + JSON.stringify({ num: '0000000103', header: { partner: '  ПАРТНЬОРИ:X  ' } }))
      writeFileSync(join(dir, 'invoicem_3000000999.json'), JSON.stringify({ header: { docNumber: '3000000999', partner: 'ПАРТНЬОРИ:КЛИЕНТ' } }))
      writeFileSync(join(dir, 'manifest.sha256'), 'not json')
      expect(collectPartners(dir)).toEqual({ '3000000101': 'ПАРТНЬОРИ:АЛФА ТЕСТ ЕООД', '3000000104': '', '103': 'ПАРТНЬОРИ:X' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The documents print a partner as PlusMinus's partner list spells it; the suppliers were seeded from its ledger,
 * which spells many of them with other punctuation, and keeps some companies a second time as customers.
 */
describe('the same company under another spelling', () => {
  let fourth: any
  const c: Record<string, any> = {}
  const m: Record<string, any> = {}

  beforeAll(async () => {
    fourth = await createTestOrg({ name: 'Четвърти', slug: 'receipt-supplier-backfill-spelling' } as any)
    const contact = async (key: string, type: string, companyName: string, extra: Record<string, unknown> = {}) => {
      c[key] = await createTestContact(fourth._id, { type, companyName, ...extra } as any)
    }
    await contact('hyphen', 'supplier', 'ТЕСТ-04 ООД')
    await contact('dots', 'supplier', 'F.TEST Nchfg.GMBH')
    await contact('alikeA', 'supplier', 'ДВЕ-ТОЧКИ ООД')
    await contact('alikeB', 'supplier', 'ДВЕ ТОЧКИ ООД')
    await contact('exactA', 'supplier', 'ЕДНО-ИМЕ ООД')
    await contact('exactB', 'supplier', 'ЕДНО - ИМЕ ООД')
    await contact('longer', 'supplier', 'КРАТКО ТРЕЙД ЕООД')
    // The same company twice: a customer under the name the documents print, a supplier under its ledger name.
    await contact('twinCustomer', 'customer', 'ДВОЕН ООД', { taxId: '111222333' })
    await contact('twinSupplier', 'supplier', 'СД ДВОЕН И СИЕ', { taxId: '111222333', vatNumber: 'BG111222333' })
    await contact('vatCustomer', 'customer', 'ВАТ КЛИЕНТ ЕООД', { vatNumber: 'BG 444555666' })
    await contact('vatSupplier', 'supplier', 'ВАТ ДОСТАВЧИК - ЕООД', { taxId: '444555666' })
    await contact('sharedCustomer', 'customer', 'ОБЩ ООД', { taxId: '777888999' })
    await contact('sharedSupplierA', 'supplier', 'ОБЩ ДОСТАВЧИК А', { taxId: '777888999' })
    await contact('sharedSupplierB', 'supplier', 'ОБЩ ДОСТАВЧИК Б', { taxId: '777888999' })
    await contact('shortCustomer', 'customer', 'КЪС ООД', { taxId: '123' })
    await contact('shortSupplier', 'supplier', 'КЪС ДОСТАВЧИК', { taxId: '123' })
    await contact('goneCustomer', 'customer', 'СПРЯН ООД', { taxId: '555666777' })
    await contact('goneSupplier', 'supplier', 'СПРЯН ДОСТАВЧИК', { taxId: '555666777', isActive: false })

    const article = await createTestProduct(fourth._id)
    let day = 0
    const make = async (key: string, partner: string) => {
      m[key] = await createTestStockMovement(fourth._id, {
        movementNumber: `SM-S-${key}`, type: 'receipt', status: 'completed', date: new Date(Date.UTC(2026, 8, ++day)),
        toWarehouseId: warehouse._id, createdBy: owner._id,
        lines: [{ productId: article._id, quantity: 1, unitCost: 1, totalCost: 1 }], totalAmount: 1,
        notes: deliveryNote('2026-09-01', movementMarker('goods_receipt', String(3000001000 + day)), `ПАРТНЬОРИ:${partner}`),
      } as any)
    }
    await make('hyphen', 'ТЕСТ - 04 ООД')
    await make('dots', 'F.TEST Nchfg. GmbH')
    await make('alike', 'ДВЕ - ТОЧКИ ООД')
    await make('exact', 'ЕДНО - ИМЕ ООД')
    await make('shorter', 'КРАТКО ТРЕЙД')
    await make('twin', 'ДВОЕН ООД')
    await make('twinByVat', 'ВАТ КЛИЕНТ ЕООД')
    await make('shared', 'ОБЩ ООД')
    await make('shortNumber', 'КЪС ООД')
    await make('goneSupplier', 'СПРЯН ООД')
  })

  it('finds the supplier by the same words, and by the tax number of the customer that has the name', async () => {
    const { plans, counts } = await planReceiptSupplierBackfill(String(fourth._id))
    expect(plans.map(p => [p.movementNumber, p.rule, p.contactId])).toEqual([
      ['SM-S-hyphen', 'punctuation', String(c.hyphen._id)],
      ['SM-S-dots', 'punctuation', String(c.dots._id)],
      // Its exact name is one supplier, whatever else is alike.
      ['SM-S-exact', 'name', String(c.exactB._id)],
      ['SM-S-twin', 'taxNumber', String(c.twinSupplier._id)],
      // A Bulgarian VAT number is the ЕИК with BG before it.
      ['SM-S-twinByVat', 'taxNumber', String(c.vatSupplier._id)],
    ])
    expect(plans.find(p => p.movementNumber === 'SM-S-twin')!.supplierName).toBe('СД ДВОЕН И СИЕ')
    expect(counts).toMatchObject({ receipts: 10, resolved: 5, unresolved: 5 })
  })

  it('and reports what is still nobody, with why', async () => {
    const { unresolved } = await planReceiptSupplierBackfill(String(fourth._id))
    const by = new Map(unresolved.map(u => [u.name, u]))
    expect([...by.keys()].sort()).toEqual(['ДВЕ - ТОЧКИ ООД', 'КРАТКО ТРЕЙД', 'КЪС ООД', 'ОБЩ ООД', 'СПРЯН ООД'])
    // Two suppliers alike but for their punctuation.
    expect(by.get('ДВЕ - ТОЧКИ ООД')).toMatchObject({ reason: 'ambiguous', candidates: 2 })
    // A shorter name is another company.
    expect(by.get('КРАТКО ТРЕЙД')).toMatchObject({ reason: 'none' })
    // Two suppliers carry that customer's tax number: neither is chosen.
    expect(by.get('ОБЩ ООД')).toMatchObject({ reason: 'none', heldBy: 'customer' })
    // Three digits are no tax number.
    expect(by.get('КЪС ООД')).toMatchObject({ reason: 'none', heldBy: 'customer' })
    // The only supplier with that number is deactivated.
    expect(by.get('СПРЯН ООД')).toMatchObject({ reason: 'none', heldBy: 'customer' })
  })

  it('the importers\' matcher over the database follows the same rule', async () => {
    const id = String(fourth._id)
    expect(await matchSupplierByName(id, 'тест-04  оод')).toEqual({ status: 'matched', contactId: String(c.hyphen._id), name: 'ТЕСТ-04 ООД' })
    expect(await matchSupplierByName(id, 'ПАРТНЬОРИ ТЕСТ - 04 ООД'.replace('ПАРТНЬОРИ ', ''))).toEqual({ status: 'matched', contactId: String(c.hyphen._id), name: 'ТЕСТ-04 ООД', by: 'punctuation' })
    expect(await matchSupplierByName(id, 'F.TEST Nchfg. GmbH')).toMatchObject({ status: 'matched', contactId: String(c.dots._id), by: 'punctuation' })
    expect(await matchSupplierByName(id, 'ЕДНО - ИМЕ ООД')).toEqual({ status: 'matched', contactId: String(c.exactB._id), name: 'ЕДНО - ИМЕ ООД' })
    expect(await matchSupplierByName(id, 'ДВЕ - ТОЧКИ ООД')).toEqual({ status: 'ambiguous', count: 2 })
    expect(await matchSupplierByName(id, 'КРАТКО ТРЕЙД')).toEqual({ status: 'none' })
    // A customer of that name is nobody to this rule, and another organization's supplier is never read.
    expect(await matchSupplierByName(id, 'ДВОЕН ООД')).toEqual({ status: 'none' })
    expect(await matchSupplierByName(String(other._id), 'ТЕСТ - 04 ООД')).toEqual({ status: 'none' })
  })

  it('writes them, each to the supplier the rule found', async () => {
    const { plans } = await planReceiptSupplierBackfill(String(fourth._id))
    for (const p of plans) expect(await applyReceiptSupplier(String(fourth._id), p, owner._id, REASON)).toBe(true)
    expect(String((await StockMovement.findById(m.twin._id).lean().exec() as any).contactId)).toBe(String(c.twinSupplier._id))
    expect(String((await StockMovement.findById(m.hyphen._id).lean().exec() as any).contactId)).toBe(String(c.hyphen._id))
    expect((await StockMovement.findById(m.shared._id).lean().exec() as any).contactId).toBeUndefined()
    expect((await planReceiptSupplierBackfill(String(fourth._id))).plans).toEqual([])
  })
})
