import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mongoose } from 'db/connection'
import { AuditLog, DocFile, StockMovement } from 'db/models'
import { deliveryNote, movementMarker, reconcileNote, removalReversalNote } from 'config/movement-notes'
import { getSupplierFacts } from 'services/biz/product-suppliers.service'
import { unmatchedPartnerWarning } from 'services/biz/doc-import/supplier-name'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestStockMovement, createTestUser, createTestWarehouse } from '../helpers/factories'
import {
  applyReceiptSupplier, countUndoable, planReceiptSupplierBackfill, undoReceiptSupplier,
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
