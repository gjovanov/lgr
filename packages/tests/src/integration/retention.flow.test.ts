import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct,
  createTestJournalEntry, createTestStockMovement, createTestPOSTransaction,
  createTestPayrollRun, createTestEmployee, createTestFiscalYear,
  createTestFiscalPeriod, createTestPOSSession, createTestWarehouse,
} from '../helpers/factories'
import { config } from 'config'
import {
  EmailLog, DocFile, Invoice, JournalEntry, StockMovement, POSTransaction,
  PayrollRun, AuditLog, Sequence,
} from 'db/models'
import { retentionTick, TOUCHABLE } from 'services/biz/retention/retention.service'
import type { Types } from 'mongoose'

/**
 * FR-13.43–13.46 (#24) — the only scheduled deletion in the product.
 *
 * The thing under test is not "does it delete old rows". Any four-line `deleteMany` does
 * that. It is: **can this job ever reach a fiscal collection?** ЗСч чл. 12 / ДОПК чл. 38
 * ал. 1 require ten years and payroll fifty, and a retention bug is silent, delayed and
 * unrecoverable — nobody notices a missing row until they need it, years later, by which
 * time every backup holding it has rotated out. Every count assertion below is guarding
 * that, not the arithmetic.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const NOW = new Date('2026-09-11T12:00:00.000Z')
const daysBefore = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000)

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

/**
 * ⚠ Inserted through the DRIVER, not the model. `timestamps: true` makes Mongoose own
 * `createdAt` on both `create` and `updateOne`, so a row written through the model and then
 * backdated comes back with today's date and every age assertion below silently passes on a
 * row that is not old. The native collection is the only way to state the date and mean it.
 */
async function emailLogAged(days: number, orgId: Types.ObjectId, body = '<p>hello</p>') {
  const at = daysBefore(days)
  const res = await EmailLog.collection.insertOne({
    orgId, from: 'a@b.c', to: 'd@e.f', subject: 'test', body, status: 'sent',
    attachmentNames: [], createdAt: at, updatedAt: at, __v: 0,
  } as any)
  return res.insertedId
}

describe('EmailLog body retention (FR-13.43)', () => {
  it('strips the body past the window and KEEPS the row', async () => {
    const org = await createTestOrg()
    const old = await emailLogAged(120, org._id as Types.ObjectId)
    const fresh = await emailLogAged(10, org._id as Types.ObjectId)

    const out = await retentionTick(NOW)
    expect(out.emailBodiesStripped).toBe(1)

    // ⚠ The row survives. It still answers "was this emailed, when, did it fail" — which is
    // what the FR-10.6 double-click guard and the digest's failed-email section read. Only
    // the weight goes; at ~52 KB/row the body IS the weight.
    const stripped: any = await EmailLog.findById(old).lean().exec()
    expect(stripped).toBeTruthy()
    expect(stripped.body).toBeUndefined()
    expect(stripped.subject).toBe('test')
    expect(stripped.status).toBe('sent')

    const kept: any = await EmailLog.findById(fresh).lean().exec()
    expect(kept.body).toBe('<p>hello</p>')
  })

  it('leaves a stripped row writable', async () => {
    const org = await createTestOrg()
    const id = await emailLogAged(120, org._id as Types.ObjectId)
    await retentionTick(NOW)

    // ⚠ The reason `body` had to stop being `required: true`. Mongoose validates the whole
    // document on `save()`, so a required-but-absent path makes an unrelated field update
    // throw — the row would be readable and unwritable, and a status change on a year-old
    // log would start failing long after anyone connected it to retention.
    const doc: any = await EmailLog.findById(id).exec()
    doc.status = 'failed'
    doc.error = 'bounced'
    await doc.save()

    const after: any = await EmailLog.findById(id).lean().exec()
    expect(after.status).toBe('failed')
    expect(after.body).toBeUndefined()
  })

  it('deletes the row entirely past the longer window', async () => {
    const org = await createTestOrg()
    await emailLogAged(400, org._id as Types.ObjectId)
    const within = await emailLogAged(200, org._id as Types.ObjectId)

    const out = await retentionTick(NOW)
    expect(out.emailLogsDeleted).toBe(1)
    expect(await EmailLog.countDocuments({})).toBe(1)
    expect(await EmailLog.findById(within).lean().exec()).toBeTruthy()
  })

  it('does not strip a row it is about to delete', async () => {
    const org = await createTestOrg()
    await emailLogAged(400, org._id as Types.ObjectId)

    // ⚠ Ordering, not arithmetic. Deleting first means an ancient row is never rewritten on
    // its way out; reversed, a first run against years of backlog would write every row once
    // and immediately delete it — the most expensive possible route to the same state.
    const out = await retentionTick(NOW)
    expect(out.emailLogsDeleted).toBe(1)
    expect(out.emailBodiesStripped).toBe(0)
  })

  it('is idempotent — a second pass finds nothing left to do', async () => {
    const org = await createTestOrg()
    await emailLogAged(120, org._id as Types.ObjectId)
    await emailLogAged(400, org._id as Types.ObjectId)

    await retentionTick(NOW)
    const second = await retentionTick(NOW)
    expect(second.emailBodiesStripped).toBe(0)
    expect(second.emailLogsDeleted).toBe(0)
  })

  it('respects the batch cap and reports that more remains', async () => {
    const org = await createTestOrg()
    const original = config.retention.batchSize
    config.retention.batchSize = 2
    try {
      for (let i = 0; i < 5; i++) await emailLogAged(120, org._id as Types.ObjectId)
      const out = await retentionTick(NOW)
      expect(out.emailBodiesStripped).toBe(2)
      // ⚠ The caller has to know the backlog is not cleared, or a first run against years of
      // rows would look finished while most of the weight is still there.
      expect(out.more).toBe(true)
      expect(await EmailLog.countDocuments({ body: { $exists: true } })).toBe(3)
    } finally {
      config.retention.batchSize = original
    }
  })
})

describe('DocFile compareSummary (FR-13.45)', () => {
  async function docFile(orgId: Types.ObjectId, status: string) {
    const user = await createTestUser(orgId)
    return DocFile.create({
      orgId, docType: 'invoice', docNumber: `INV-${status}-${Math.random()}`,
      docDate: '2026-01-15', originalName: `f-${status}.pdf`,
      currentPath: `docs/2026-01/f-${status}.pdf`, currentChecksum: 'a'.repeat(64),
      mimeType: 'application/pdf', size: 1234, uploadedBy: user._id, status,
      compareSummary: { diff: 'something large and settled' },
    } as any)
  }

  it('strips it once the document is settled, and not before', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const committed = await docFile(orgId, 'committed')
    const superseded = await docFile(orgId, 'superseded')
    const analyzed = await docFile(orgId, 'analyzed')

    const out = await retentionTick(NOW)
    expect(out.compareSummariesStripped).toBe(2)

    expect((await DocFile.findById(committed._id).lean().exec() as any).compareSummary).toBeUndefined()
    expect((await DocFile.findById(superseded._id).lean().exec() as any).compareSummary).toBeUndefined()
    // ⚠ Gated on STATUS, not age. The summary is the working state of the availability diff;
    // while a document is still `analyzed` something is using it, however old it is.
    expect((await DocFile.findById(analyzed._id).lean().exec() as any).compareSummary).toBeTruthy()
  })

  it('never removes the file itself or its checksum', async () => {
    const org = await createTestOrg()
    const f = await docFile(org._id as Types.ObjectId, 'committed')
    await retentionTick(NOW)

    const after: any = await DocFile.findById(f._id).lean().exec()
    expect(after).toBeTruthy()
    expect(after.currentChecksum).toBe('a'.repeat(64))
    expect(after.originalName).toBeTruthy()
    expect(after.currentPath).toBeTruthy()
  })
})

describe('the fiscal collections, which must never be touched (FR-13.44)', () => {
  it('leaves every fiscal collection at exactly the count it started with', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId

    // A row in each collection the ordinance protects, aged far past every retention window
    // this module knows about. If a cutoff ever escapes its collection, these are what it
    // reaches first.
    const user = await createTestUser(orgId)
    const contact = await createTestContact(orgId)
    const product = await createTestProduct(orgId)
    const fiscalYear = await createTestFiscalYear(orgId)
    const period = await createTestFiscalPeriod(orgId, fiscalYear._id as any)
    const warehouse = await createTestWarehouse(orgId)
    const session = await createTestPOSSession(orgId, warehouse._id as any, user._id as any)
    const employee = await createTestEmployee(orgId)

    await createTestInvoice(orgId, contact._id as any)
    await createTestJournalEntry(orgId, period._id as any, user._id as any)
    await createTestStockMovement(orgId)
    await createTestPOSTransaction(orgId, session._id as any, user._id as any)
    await createTestPayrollRun(orgId, user._id as any)
    await AuditLog.create({
      orgId, userId: user._id, action: 'create', module: 'admin',
      entityType: 'test', entityId: String(product._id),
    } as any)
    await Sequence.create({ orgId, prefix: 'INV', year: 2020, lastNumber: 42 } as any)

    // ⚠ Backdate EVERYTHING by twenty years. Payroll alone carries a fifty-year floor, and a
    // retention job that filtered on age without filtering on collection would take all of it.
    const ancient = new Date(NOW.getTime() - 20 * 365 * 24 * 60 * 60 * 1000)
    for (const M of [Invoice, JournalEntry, StockMovement, POSTransaction, PayrollRun, AuditLog, Sequence]) {
      // Raw: the dates as stored, past the timestamps plugin and the frozen POSTransaction model (FR-21.26).
      await (M as any).collection.updateMany({}, { $set: { createdAt: ancient, updatedAt: ancient } })
    }

    const before = {
      Invoice: await Invoice.countDocuments({}),
      JournalEntry: await JournalEntry.countDocuments({}),
      StockMovement: await StockMovement.countDocuments({}),
      POSTransaction: await POSTransaction.countDocuments({}),
      PayrollRun: await PayrollRun.countDocuments({}),
      AuditLog: await AuditLog.countDocuments({}),
      Sequence: await Sequence.countDocuments({}),
    }
    for (const [name, n] of Object.entries(before)) {
      expect(`${name}=${n}`).toBe(`${name}=1`)   // the fixture itself must be real
    }

    await retentionTick(NOW)

    const after = {
      Invoice: await Invoice.countDocuments({}),
      JournalEntry: await JournalEntry.countDocuments({}),
      StockMovement: await StockMovement.countDocuments({}),
      POSTransaction: await POSTransaction.countDocuments({}),
      PayrollRun: await PayrollRun.countDocuments({}),
      AuditLog: await AuditLog.countDocuments({}),
      Sequence: await Sequence.countDocuments({}),
    }
    expect(after).toEqual(before)
  })

  it('names exactly two collections as touchable, and one field each', async () => {
    // ⚠ A change-detector on purpose. Adding a collection here is a compliance decision, not
    // a refactor, and it should not be possible to make it quietly — this test is the place
    // the argument has to be written down again.
    expect(Object.keys(TOUCHABLE).sort()).toEqual(['DocFile', 'EmailLog'])
    expect(TOUCHABLE.EmailLog).toEqual(['body'])
    expect(TOUCHABLE.DocFile).toEqual(['compareSummary'])
  })

  it('a sequence keeps its counter, so numbering cannot restart', async () => {
    const org = await createTestOrg()
    await Sequence.create({ orgId: org._id, prefix: 'INV', year: 2019, lastNumber: 1200 } as any)
    await Sequence.updateMany({}, { $set: { createdAt: daysBefore(4000), updatedAt: daysBefore(4000) } }).exec()

    await retentionTick(NOW)

    // Deleting an old `Sequence` would let numbering restart at 1 and reissue invoice numbers
    // already in customers' hands — the same failure FR-13.35 clamps against on restore,
    // reached from the other side.
    const seq: any = await Sequence.findOne({ prefix: 'INV', year: 2019 }).lean().exec()
    expect(seq.lastNumber).toBe(1200)
  })
})
