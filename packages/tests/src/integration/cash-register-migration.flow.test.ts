import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Types } from 'mongoose'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestContact, createTestPOSSession,
} from '../helpers/factories'
import { mongoose } from 'db/connection'
import { BackupRun, DocFile, Invoice, POSTransaction, StockMovement } from 'db/models'
import { config } from 'config'
import { runMigrations, COLLECTION } from 'migrations/runner'
import { cashRegisterCopy } from 'migrations/migrations/0008-cash-register-copy'
import { cashRegisterFreeze } from 'migrations/migrations/0009-cash-register-freeze'
import { FrozenCollectionError } from 'db/plugins/frozen.plugin'
import {
  CashRegisterCopyError, cashRegisterParity, cashRegisterPreflight, copyCashRegisterOrg,
} from 'services/biz/cash-register/copy-org'
import { copyPosRow } from 'services/biz/cash-register/copy'
import { listJournal } from 'services/biz/cash-register/journal.service'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { inspectBundle, applyRestore } from 'services/biz/backup/backup-restore.service'
import { BGN_PER_EUR } from 'services/biz/cash-register/mapping'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * FR-21.21 / FR-21.22 — migration `0008-cash-register-copy` and the restore that runs it (§5.3).
 *
 * One org holds every shape a POS row comes in (§8.1): a fiscal printed sale, a text receipt, a
 * failed print, a Tremol print in state `unknown`, a stornoed sale and its storno in another
 * session, a storno whose print failed (voided), split tender with change, mobile and voucher, a
 * customer, a BGN session in an EUR org, a sale with `stockError`, a keyed sale, a session left
 * open, and a POS-OUT batch. Each is copied under its own `_id`, its movement linked, the org's
 * other cash sales labelled, and parity holds; a second run changes nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let TMP = ''
beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-fr21-copy-'))
  config.upload.dir = TMP
}, 60_000)
afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const db = () => mongoose.connection.db!
const ObjectId = mongoose.Types.ObjectId
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m))

/** An org whose till history is still all POS rows, as R1 left it. */
async function legacyOrg(slug = `legacy-${Date.now()}`) {
  const org = await createTestOrg({ slug, settings: { baseCurrency: 'EUR', timezone: 'Europe/Sofia' } } as any)
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId)
  const wh = await createTestWarehouse(orgId)
  const product = await createTestProduct(orgId, { name: 'Болт М8', unit: 'бр.' } as any)
  const customer = await createTestContact(orgId)
  const closed = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, { status: 'closed' } as any)
  const open = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, { status: 'open' } as any)
  const lev = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, { status: 'closed', currency: 'BGN' } as any)
  const line = (q: number) => ({ productId: product._id, name: 'Болт М8', quantity: q, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2 * q, lineTotal: 10 * q })
  let n = 0
  const row = (over: Record<string, any> = {}) => {
    n++
    const at = T(9, n)
    return {
      _id: new ObjectId(), orgId, sessionId: closed._id, transactionNumber: `TXN-2026-${String(n).padStart(7, '0')}`,
      type: 'sale', status: 'completed', lines: [line(2)], subtotal: 20, discountTotal: 0, taxTotal: 4, total: 24,
      payments: [{ method: 'cash', amount: 24 }], changeDue: 0, createdBy: user._id,
      createdAt: at, updatedAt: at, completedAt: at, sessionTotalsApplied: true,
      ...over,
    }
  }
  const dispatch = new ObjectId()
  await StockMovement.collection.insertOne({
    _id: dispatch, orgId, movementNumber: 'SM-2026-00001', type: 'dispatch', status: 'completed', date: T(9),
    fromWarehouseId: wh._id, notes: 'POS sale TXN-2026-0000001',
    lines: [{ productId: product._id, quantity: 2, unitCost: 10, totalCost: 20, resolvedUnitCost: 4 }], totalAmount: 20,
    createdBy: user._id, createdAt: T(9), updatedAt: T(9),
  } as any)
  await StockMovement.collection.insertOne({
    _id: new ObjectId(), orgId, movementNumber: 'POS-OUT-2026-000001', type: 'dispatch', status: 'completed', date: T(18),
    fromWarehouseId: wh._id, lines: [], totalAmount: 0, recordOnly: true, createdBy: user._id, createdAt: T(18), updatedAt: T(18),
  } as any)

  const printed = row({
    unpNumber: 'ED123456-0001-0000001', fiscalReceiptNumber: '0000101', fiscalDeviceNumber: 'ED123456', isFiscal: true, printedAt: T(9, 1),
    fiscal: { state: 'printed', mode: 'fiscal', receiptNo: '0000101', printedAt: T(9, 1) }, movementId: dispatch,
  })
  const stornoed = row({ status: 'cancelled', unpNumber: 'ED123456-0001-0000002', fiscalReceiptNumber: '0000102', isFiscal: true, fiscalDeviceNumber: 'ED123456', updatedAt: T(15) })
  const failedStornoOf = row()
  const rows = [
    printed,
    row({ fiscal: { state: 'printed', mode: 'text', printedAt: T(9, 2) }, printedAt: T(9, 2), fiscalDeviceNumber: 'ED123456' }),
    row({ fiscal: { state: 'failed', mode: 'fiscal', error: 'paper out' }, receiptError: 'paper out' }),
    row({ fiscal: { state: 'unknown', mode: 'fiscal', attemptedAt: T(9, 4) }, receiptError: 'The receipt was interrupted' }),
    stornoed,
    // Its storno, a session later, keeps the sale's tendered payments and no change of its own (#145).
    row({
      type: 'storno', sessionId: open._id, originalTransactionId: stornoed._id, originalUNP: 'ED123456-0001-0000002',
      originalFiscalReceiptNumber: '0000102', originalTransactionDate: stornoed.createdAt, stornoReason: 'customer_return',
      unpNumber: 'ED123456-0001-0000003', fiscalReceiptNumber: '0000103', isFiscal: true, fiscalDeviceNumber: 'ED123456',
      payments: [{ method: 'cash', amount: 30 }], createdAt: T(15), updatedAt: T(15),
    }),
    failedStornoOf,
    row({ type: 'storno', status: 'cancelled', originalTransactionId: failedStornoOf._id, receiptError: 'paper out', stornoReason: 'operator_error', updatedAt: T(16) }),
    row({ lines: [line(3)], subtotal: 30, taxTotal: 6, total: 36, payments: [{ method: 'card', amount: 20 }, { method: 'cash', amount: 30 }], changeDue: 14 }),
    row({ payments: [{ method: 'mobile', amount: 20 }, { method: 'voucher', amount: 4 }] }),
    row({ customerId: customer._id }),
    row({ sessionId: lev._id }),
    row({ stockError: 'write concern timeout' }),
    row({ clientKey: 'legacy-key-0001', requestHash: 'h-legacy' }),
  ]
  await POSTransaction.collection.insertMany(rows as any[])

  // The org's other cash sales, none labelled yet.
  const sale = (over: Record<string, any>) => Invoice.collection.insertOne({
    _id: new ObjectId(), orgId, type: 'cash_sale', direction: 'outgoing', status: 'paid', currency: 'EUR', exchangeRate: 1,
    issueDate: T(8), dueDate: T(8), lines: [], subtotal: 10, taxTotal: 2, total: 12, billingAddress: {}, attachments: [],
    createdBy: user._id, createdAt: T(8), updatedAt: T(8), ...over,
  } as any)
  const imported = await sale({ invoiceNumber: 'CSR-2026-00001', reference: 'salesAnalysis:2026-10-19', tags: ['cash-register-import'] })
  const backOffice = await sale({ invoiceNumber: 'CS-2026-00001' })
  const viaFiles = await sale({ invoiceNumber: 'CS-2026-00002' })
  await DocFile.collection.insertOne({ orgId, committedTarget: 'invoice', committedIds: [viaFiles.insertedId], status: 'committed' } as any)

  return {
    org, orgId, user, wh, product, closed, open, lev, rows, printed, stornoed, dispatch,
    imported: imported.insertedId, backOffice: backOffice.insertedId, viaFiles: viaFiles.insertedId,
  }
}

const up = () => cashRegisterCopy.up({ db: db(), log: () => {}, orgFilter: {} })

describe('0008 — the copy', () => {
  it('copies every row under its own _id, number, УНП and times; links the movement; labels the other cash sales; parity holds', async () => {
    const w = await legacyOrg()
    const journalBefore = await listJournal({ orgId: String(w.orgId), size: 0 })
    const tillBefore = await loadPosRows({ orgId: String(w.orgId) })

    await up()

    const copies: any[] = await Invoice.find({ orgId: w.orgId, 'register.legacy.source': 'postransactions' }).lean()
    expect(copies).toHaveLength(w.rows.length)
    for (const row of w.rows as any[]) {
      const copy = copies.find(c => String(c._id) === String(row._id))
      expect(copy, row.transactionNumber).toBeTruthy()
      expect(copy.invoiceNumber).toBe(row.transactionNumber)
      expect(new Date(copy.createdAt).getTime()).toBe(row.createdAt.getTime())
      expect(copy.register.origin).toBe('pos')
    }
    const byNumber = (n: string) => copies.find(c => c.invoiceNumber === n)
    // The printed sale: its УНП and receipt, and its movement now names it.
    expect(byNumber(w.printed.transactionNumber).register).toMatchObject({ unp: 'ED123456-0001-0000001', fiscalReceiptNumber: '0000101', isFiscal: true })
    expect(String((await StockMovement.findById(w.dispatch).lean() as any).invoiceId)).toBe(String(w.printed._id))
    // The stornoed sale stays paid and is marked; its storno, in another session, refunds what was kept.
    const sale = byNumber(w.stornoed.transactionNumber)
    expect(sale.status).toBe('paid')
    expect(sale.register).toMatchObject({ stornoState: 'full', cancelledAt: T(15) })
    const storno = copies.find(c => c.type === 'cash_storno' && c.status === 'paid')
    expect(sale.register.stornoedBy.map(String)).toEqual([String(storno._id)])
    expect(storno.payments.map((p: any) => [p.method, p.amount, p.tendered])).toEqual([['cash', 24, 30]])
    // The storno whose print failed reversed nothing: voided.
    expect(copies.filter(c => c.type === 'cash_storno' && c.status === 'voided')).toHaveLength(1)
    // Split tender: the change came off the cash; mobile and voucher kept as they were.
    const split = copies.find(c => c.total === 36)
    expect(split.payments.map((p: any) => [p.method, p.amount])).toEqual([['card', 20], ['cash', 16]])
    expect(copies.some(c => c.payments.some((p: any) => p.method === 'voucher'))).toBe(true)
    // The BGN session's sale is in BGN, at the fixed rate.
    const lev = copies.find(c => String(c.register.sessionId) === String(w.lev._id))
    expect(lev.currency).toBe('BGN')
    expect(lev.exchangeRate).toBeCloseTo(1 / BGN_PER_EUR, 10)
    // The keyed sale keeps its key, so a retry across the deploy finds it.
    expect(copies.find(c => c.clientKey === 'legacy-key-0001')).toBeTruthy()
    // The org's other cash sales are labelled.
    const origin = async (id: unknown) => (await Invoice.findById(id).lean() as any).register.origin
    expect(await origin(w.imported)).toBe('import')
    expect(await origin(w.backOffice)).toBe('backoffice')
    expect(await origin(w.viaFiles)).toBe('import')

    // Parity, and every reader that unions both stores reads the same rows as before, each once.
    expect(await cashRegisterParity(db() as any, String(w.orgId))).toEqual([])
    const journalAfter = await listJournal({ orgId: String(w.orgId), size: 0 })
    expect(journalAfter.total).toBe(journalBefore.total)
    expect(journalAfter.rows.every(r => r.store === 'invoice')).toBe(true)
    const tillAfter = await loadPosRows({ orgId: String(w.orgId) })
    expect(tillAfter.map(t => [t.id, t.transactionNumber, t.status, t.total])).toEqual(tillBefore.map(t => [t.id, t.transactionNumber, t.status, t.total]))
    // The rows are where they were: expand only.
    expect(await POSTransaction.countDocuments({ orgId: w.orgId })).toBe(w.rows.length)
  }, 60_000)

  it('a second run changes nothing (and the runner records it once)', async () => {
    await legacyOrg()
    const res = await runMigrations({ db: db() })
    expect(res.applied).toContain('0008-cash-register-copy')
    const snap = async () => JSON.stringify([
      await Invoice.find({}).sort({ _id: 1 }).lean(), await StockMovement.find({}).sort({ _id: 1 }).lean(),
    ])
    const once = await snap()
    await up()
    expect(await snap()).toBe(once)
  }, 60_000)

  it('a sale stornoed under R2 before the copy: parity reads its row as the copy reads it', async () => {
    const w = await legacyOrg()
    // Copied on the spot and reversed by an R2 storno document; its frozen row still says `completed`.
    const copy = await copyPosRow(String(w.orgId), String(w.printed._id))
    const r2Storno = new ObjectId()
    await Invoice.collection.insertOne({
      _id: r2Storno, orgId: w.orgId, invoiceNumber: 'CS-2026-00009', type: 'cash_storno', direction: 'outgoing', status: 'paid',
      currency: 'EUR', exchangeRate: 1, issueDate: T(17), dueDate: T(17), lines: [], subtotal: 20, taxTotal: 4, total: 24,
      billingAddress: {}, attachments: [], relatedInvoiceId: copy._id, register: { origin: 'pos' }, createdBy: w.user._id,
    } as any)
    await Invoice.updateOne({ _id: copy._id }, { $set: { 'register.stornoState': 'full', 'register.cancelledAt': T(17), 'register.stornoedBy': [r2Storno] } })

    await up()

    expect(await cashRegisterParity(db() as any, String(w.orgId))).toEqual([])
    expect((await Invoice.findById(w.printed._id).lean() as any).register.stornoState).toBe('full')
  }, 60_000)

  it("the digest's numbering checks the copies' TXN series on its own line, never as gaps in CS", async () => {
    const w = await legacyOrg()
    await up()
    const digest: any = await buildDailyDigest(String(w.orgId), '2026-10-20')
    const cash = digest.documents.cash
    expect(cash.sequence.key).toBe('CASH_SALE')
    expect(cash.sequence.missing).toEqual([])
    expect(cash.closedSequences.map((s: any) => s.key)).toEqual(['TXN'])
    expect(cash.closedSequences[0].count).toBe(w.rows.length)
    expect(cash.closedSequences[0].lastNumberMismatch).toBeUndefined()
  }, 60_000)
})

describe('0008 — what stops it', () => {
  it('a blocker stops the org before anything is written, and the migration is not recorded', async () => {
    const w = await legacyOrg()
    await POSTransaction.collection.insertOne({
      _id: new ObjectId(), orgId: w.orgId, sessionId: w.closed._id, transactionNumber: 'TXN-2026-0000099', type: 'return',
      status: 'completed', lines: [], subtotal: 0, total: 0, payments: [], createdBy: w.user._id, createdAt: T(20), updatedAt: T(20),
    } as any)
    await POSTransaction.collection.insertOne({
      _id: new ObjectId(), orgId: w.orgId, sessionId: new ObjectId(), transactionNumber: 'TXN-2026-0000098', type: 'sale',
      status: 'completed', lines: [], subtotal: 0, total: 0, payments: [], createdBy: w.user._id, createdAt: T(20), updatedAt: T(20),
    } as any)

    const report = await cashRegisterPreflight(db() as any, String(w.orgId))
    expect(report.blockers.map(b => b.code).sort()).toEqual(['return_exchange_rows', 'session_missing'])
    expect(report.warnings.map(w => w.code)).toEqual(expect.arrayContaining(['legacy_payment_methods', 'stock_error', 'pos_out']))

    const err = await captureRejection(runMigrations({ db: db() }))
    expect(err).toBeInstanceOf(CashRegisterCopyError)
    expect(await Invoice.countDocuments({ orgId: w.orgId, 'register.legacy.source': 'postransactions' })).toBe(0)
    expect(await db().collection(COLLECTION).findOne({ _id: '0008-cash-register-copy' as any })).toBeNull()
  }, 60_000)

  it("one org's blocker does not hold another org back; the migration still is not recorded", async () => {
    const blocked = await legacyOrg('legacy-blocked')
    const clean = await legacyOrg('legacy-clean')
    await POSTransaction.collection.insertOne({
      _id: new ObjectId(), orgId: blocked.orgId, sessionId: blocked.closed._id, transactionNumber: 'TXN-2026-0000099', type: 'return',
      status: 'completed', lines: [], subtotal: 0, total: 0, payments: [], createdBy: blocked.user._id, createdAt: T(20), updatedAt: T(20),
    } as any)

    const err: any = await captureRejection(runMigrations({ db: db() }))
    expect(err).toBeInstanceOf(CashRegisterCopyError)
    expect(String(err.message)).toContain(String(blocked.orgId))
    expect(await Invoice.countDocuments({ orgId: blocked.orgId, 'register.legacy.source': 'postransactions' })).toBe(0)
    expect(await Invoice.countDocuments({ orgId: clean.orgId, 'register.legacy.source': 'postransactions' })).toBe(clean.rows.length)
    expect(await cashRegisterParity(db() as any, String(clean.orgId))).toEqual([])
    expect(await db().collection(COLLECTION).findOne({ _id: '0008-cash-register-copy' as any })).toBeNull()
  }, 60_000)

  it('a copy the model refuses stops its batch before the batch is written', async () => {
    const w = await legacyOrg()
    await POSTransaction.collection.updateOne({ _id: (w.rows[2] as any)._id }, { $set: { payments: [{ method: 'bitcoin', amount: 24 }] } })
    const err: any = await captureRejection(copyCashRegisterOrg(db() as any, String(w.orgId)))
    expect(err).toBeInstanceOf(CashRegisterCopyError)
    expect(String(err.message)).toContain('bitcoin')
    expect(await Invoice.countDocuments({ orgId: w.orgId, 'register.legacy.source': 'postransactions' })).toBe(0)
  }, 60_000)
})

describe('R3 — the freeze (FR-21.25, FR-21.26)', () => {
  const freeze = () => cashRegisterFreeze.up({ db: db(), log: () => {}, orgFilter: {} })

  it('the POSTransaction model refuses every write; raw driver writes still pass', async () => {
    const w = await legacyOrg('legacy-frozen')
    const row: any = w.rows[0]
    const attempts: [string, () => Promise<unknown>][] = [
      ['create', () => POSTransaction.create({ ...row, _id: new ObjectId(), transactionNumber: 'TXN-2026-0000777' })],
      ['insertMany', () => POSTransaction.insertMany([{ ...row, _id: new ObjectId(), transactionNumber: 'TXN-2026-0000778' }])],
      ['updateOne', () => POSTransaction.updateOne({ _id: row._id }, { $set: { status: 'cancelled' } }).exec()],
      ['updateMany', () => POSTransaction.updateMany({ orgId: w.orgId }, { $set: { status: 'cancelled' } }).exec()],
      ['findOneAndUpdate', () => POSTransaction.findOneAndUpdate({ _id: row._id }, { $set: { status: 'cancelled' } }).exec()],
      ['deleteOne', () => POSTransaction.deleteOne({ _id: row._id }).exec()],
      ['deleteMany', () => POSTransaction.deleteMany({ orgId: w.orgId }).exec()],
      ['bulkWrite', () => POSTransaction.bulkWrite([{ deleteOne: { filter: { _id: row._id } } }])],
      ['doc.save', async () => { const d: any = await POSTransaction.findById(row._id); d.status = 'cancelled'; return d.save() }],
    ]
    for (const [name, attempt] of attempts) {
      const err: any = await captureRejection(attempt())
      expect(err, name).toBeInstanceOf(FrozenCollectionError)
      expect(String(err.message), name).toContain('postransactions is frozen (FR-21)')
    }
    // Nothing moved; and a raw write (a restore, a move, the mirror) is not stopped by the model.
    expect(await POSTransaction.countDocuments({ orgId: w.orgId })).toBe(w.rows.length)
    expect((await POSTransaction.findById(row._id).lean() as any).status).toBe('completed')
    await POSTransaction.collection.updateOne({ _id: row._id }, { $set: { note: 'raw' } })
    expect((await POSTransaction.findById(row._id).lean() as any).note).toBe('raw')
  }, 60_000)

  it('0009 copies a straggler an older release wrote after 0008, proves parity and is recorded once', async () => {
    const w = await legacyOrg('legacy-straggler')
    await up()
    // A rollback to R1 between 0008 and 0009: the till wrote one more POS row.
    const straggler: any = { ...(w.rows[1] as any), _id: new ObjectId(), transactionNumber: 'TXN-2026-0000500', createdAt: T(17), updatedAt: T(17), completedAt: T(17) }
    delete straggler.clientKey
    await POSTransaction.collection.insertOne(straggler)

    await freeze()
    const copy: any = await Invoice.findById(straggler._id).lean()
    expect(copy?.invoiceNumber).toBe('TXN-2026-0000500')
    expect(copy?.register?.origin).toBe('pos')
    expect(await cashRegisterParity(db() as any, String(w.orgId))).toEqual([])
    // A second run changes nothing.
    const snap = async () => JSON.stringify(await Invoice.find({}).sort({ _id: 1 }).lean())
    const once = await snap()
    await freeze()
    expect(await snap()).toBe(once)
    // The runner records it after 0008, once.
    const res = await runMigrations({ db: db() })
    expect(res.applied).toEqual(expect.arrayContaining(['0008-cash-register-copy', '0009-cash-register-freeze']))
    expect(await snap()).toBe(once)
  }, 60_000)

  it('0009 throws on a copy that no longer matches its row, and is not recorded', async () => {
    const w = await legacyOrg('legacy-mismatch')
    await up()
    await Invoice.collection.updateOne({ _id: (w.rows[0] as any)._id }, { $set: { total: 999 } })
    const err: any = await captureRejection(freeze())
    expect(err).toBeInstanceOf(CashRegisterCopyError)
    expect(String(err.message)).toContain(String(w.orgId))
    // Through the runner nothing past the mismatch is recorded.
    await captureRejection(runMigrations({ db: db() }))
    expect(await db().collection(COLLECTION).findOne({ _id: '0009-cash-register-freeze' as any })).toBeNull()
  }, 60_000)
})

describe('FR-21.22 — a restore converts an older bundle', () => {
  it("a bundle taken before R2: its POS rows are copied as the restore lands them", async () => {
    const w = await legacyOrg('restore-old')
    const outcome = await runBackupForOrg(String(w.orgId), '2026-10-20', { kind: 'full' })
    expect(outcome?.status).toBe('completed')
    const run: any = await BackupRun.findOne({ orgId: w.orgId }).lean()
    const actor = { userId: String(w.user._id), email: 'admin@restore.test' }

    const inspection: any = await inspectBundle(String(w.orgId), { type: 'run', runId: String(run._id) }, actor)
    const applied: any = await applyRestore(String(w.orgId), { type: 'run', runId: String(run._id) }, {
      mode: 'replace', confirmSlug: 'restore-old', inspectionId: String(inspection._id), actor,
    })

    expect(applied.status).toBe('completed')
    // Converted; and the preflight's warnings reach the operator (here: a till day also imported).
    const tillWarnings = applied.warnings.filter((x: string) => x.startsWith('POSTransaction'))
    expect(tillWarnings.some((x: string) => /did not finish/.test(x))).toBe(false)
    expect(tillWarnings.some((x: string) => /the same goods counted twice/.test(x))).toBe(true)
    expect(await Invoice.countDocuments({ orgId: w.orgId, 'register.legacy.source': 'postransactions' })).toBe(w.rows.length)
    expect(await cashRegisterParity(db() as any, String(w.orgId))).toEqual([])
  }, 120_000)
})
