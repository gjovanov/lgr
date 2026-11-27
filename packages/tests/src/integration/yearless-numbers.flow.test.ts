import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestInvoice, createTestJournalEntry, createTestOrg, createTestStockMovement } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { Invoice } from 'db/models'
import { peekNextInvoiceNumber } from 'services/biz/invoice-numbering.service'
import { setContinuousSeries } from 'services/biz/sequence.service'
import { applyYearlessNumbers, planYearlessNumbers, restoreYearNumbers } from 'services/biz/yearless-numbers'

/**
 * The sales documents an org issued with a year in their number, before it chose to number the series without one,
 * brought to the year-less form (`scripts/drop-year-from-sales-numbers.ts`). Held to a real database: a series
 * numbered per year is refused; a plan writes nothing; a run changes the number and its history and nothing else,
 * and never the series; a second run is a no-op; a restore puts it back; what cannot be given its number is left
 * and named.
 *
 * NOTE: no `.rejects` / `.resolves` (they deadlock Bun on Windows): `captureRejection`.
 */

let dir: string
let n = 0

beforeAll(async () => {
  await setupTestDB()
  dir = mkdtempSync(join(tmpdir(), 'lgr-yearless-'))
}, 60_000)
afterAll(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  await teardownTestDB()
}, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

async function world(opts: { continuous?: boolean } = {}) {
  const org = await createTestOrg({ slug: `yearless-${++n}` } as any)
  const orgId = String(org._id)
  const contact = await createTestContact(org._id)
  if (opts.continuous !== false) await setContinuousSeries(orgId, 'SALES_DOC', true)
  /** A document that carries this number, as an import or an earlier issue left it. */
  const holds = (invoiceNumber: string, extra: Record<string, unknown> = {}) =>
    createTestInvoice(org._id, contact._id, { invoiceNumber, status: 'sent', ...extra } as any)
  const doc = async (id: unknown) => (await Invoice.findById(id).lean().exec()) as any
  const numbers = async () => ((await Invoice.find({ orgId: org._id }, { invoiceNumber: 1 }).lean().exec()) as any[]).map(d => d.invoiceNumber).sort()
  const backup = () => join(dir, `backup-${n}-${Math.random().toString(36).slice(2)}.ndjson`)
  return { org, orgId, holds, doc, numbers, backup }
}

/**
 * Everything of a document but what a run may change. #929: `numberHead` / `numberSeq` are derived from the number on
 * every write, so they follow it by design (`INV-2026` → `INV`); the test below checks them against the new number.
 */
const rest = (d: any) => {
  const { invoiceNumber: _n, numberHistory: _h, updatedAt: _u, numberHead: _nh, numberSeq: _ns, ...other } = d
  return other
}

describe('a series numbered per year', () => {
  it('is refused: there the year is part of the number', async () => {
    const w = await world({ continuous: false })
    await w.holds('INV-2026-00007')
    const err = await captureRejection(planYearlessNumbers(w.orgId))
    expect(err?.code).toBe('series_not_continuous')
    expect(await w.numbers()).toEqual(['INV-2026-00007'])
  })
})

describe('the plan', () => {
  it('names the sales documents issued with a year and what each becomes, and writes nothing', async () => {
    const w = await world()
    await w.holds('INV-2026-3000000101', { status: 'paid' })
    await w.holds('INV-2025-3000000050')
    await w.holds('INV-2026-3000000077', { type: 'credit_note', status: 'voided' })
    // Not of the yearly form, or not of the sales series: none of these is read at all.
    await w.holds('INV-3000000100')
    await w.holds('DRF-INV-2026-00007', { status: 'draft' })
    await w.holds('BILL-2026-00003', { direction: 'incoming', status: 'received' })
    await w.holds('CS-2026-00001', { type: 'cash_sale', status: 'paid' })
    const before = await w.numbers()

    const plan = await planYearlessNumbers(w.orgId)
    expect(plan.rename.map(r => [r.from, r.to, r.status])).toEqual([
      ['INV-2025-3000000050', 'INV-3000000050', 'sent'],
      ['INV-2026-3000000077', 'INV-3000000077', 'voided'],
      ['INV-2026-3000000101', 'INV-3000000101', 'paid'],
    ])
    expect(plan.left).toEqual([])
    expect(plan.quoted).toEqual({ stockMovements: 0, journalEntries: 0 })
    expect(await w.numbers()).toEqual(before)
  })

  it('gives a short number its ten digits', async () => {
    const w = await world()
    await w.holds('INV-2026-00042')
    const plan = await planYearlessNumbers(w.orgId)
    expect(plan.rename.map(r => r.to)).toEqual(['INV-0000000042'])
  })

  it('leaves what cannot be given its number, and says why', async () => {
    const w = await world()
    // taken: the year-less number is another document's already
    await w.holds('INV-3000000100')
    const taken = await w.holds('INV-2026-3000000100')
    // twice: a series that started again each year
    const y25 = await w.holds('INV-2025-00007')
    const y26 = await w.holds('INV-2026-00007')
    // a draft under an issued-looking number
    const draft = await w.holds('INV-2026-00009', { status: 'draft' })
    // a number issued twice: the pair is read by it, on both documents
    const first = await w.holds('INV-2026-00011')
    const second = await w.holds('INV-2026-00011', { numberClash: { withId: first._id, withNumber: 'INV-2026-00011', source: 'fenced_export', at: new Date() } })
    // a purchase invoice that happens to read like the sales series
    const bill = await w.holds('INV-2026-00013', { direction: 'incoming', status: 'received' })
    // a payment's receipt is an invoice row too, and never one of the sales series
    const receipt = await w.holds('INV-2026-00017', { type: 'payment_receipt', status: 'paid' })
    // and one that can be given its number
    await w.holds('INV-2026-00015')

    const plan = await planYearlessNumbers(w.orgId)
    expect(plan.rename.map(r => r.from)).toEqual(['INV-2026-00015'])
    const why = Object.fromEntries(plan.left.map(l => [l.id, l.reason]))
    expect(why).toEqual({
      [String(taken._id)]: 'taken',
      [String(y25._id)]: 'twice',
      [String(y26._id)]: 'twice',
      [String(draft._id)]: 'draft',
      [String(first._id)]: 'clash_pair',
      [String(second._id)]: 'clash_pair',
      [String(bill._id)]: 'other_series',
      [String(receipt._id)]: 'other_series',
    })
  })

  it('counts the text that quotes a number it changes, and only that number', async () => {
    const w = await world()
    await w.holds('INV-2026-3000000101')
    await createTestStockMovement(w.org._id, { notes: 'Reversal for voided invoice INV-2026-3000000101' } as any)
    await createTestStockMovement(w.org._id, { reference: 'INV-2026-3000000101' } as any)
    // A longer number that begins with it is another document's.
    await createTestStockMovement(w.org._id, { notes: 'Reversal for voided invoice INV-2026-30000001019' } as any)
    await createTestJournalEntry(w.org._id, new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), { description: 'Sales invoice INV-2026-3000000101' } as any)
    await createTestJournalEntry(w.org._id, new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), { description: 'Sales invoice INV-3000000101' } as any)

    const plan = await planYearlessNumbers(w.orgId)
    expect(plan.quoted).toEqual({ stockMovements: 2, journalEntries: 1 })
  })
})

describe('a run', () => {
  it('changes the number and its history, and nothing else of the document', async () => {
    const w = await world()
    const issuedAt = new Date('2026-10-05T09:00:00Z')
    // Issued here: its history names the draft number and the issued one.
    const here = await w.holds('INV-2026-3000000101', {
      status: 'paid', draftNumber: 'DRF-INV-2026-00004', sentAt: issuedAt,
      numberHistory: [
        { number: 'DRF-INV-2026-00004', allocatedAt: new Date('2026-10-05T08:00:00Z'), status: 'draft' },
        { number: 'INV-2026-3000000101', allocatedAt: issuedAt, status: 'sent' },
      ],
    })
    // Brought in without a history.
    const bare = await w.holds('INV-2026-3000000102', { sentAt: issuedAt, numberHistory: [] })
    const [hereBefore, bareBefore] = [await w.doc(here._id), await w.doc(bare._id)]

    const now = new Date('2026-11-15T18:00:00Z')
    const plan = await planYearlessNumbers(w.orgId)
    const res = await applyYearlessNumbers(w.orgId, plan, { backupPath: w.backup(), now })
    expect(res).toEqual({ written: 2, raced: 0 })

    const [hereAfter, bareAfter] = [await w.doc(here._id), await w.doc(bare._id)]
    expect(hereAfter.invoiceNumber).toBe('INV-3000000101')
    expect(hereAfter.numberHistory).toEqual([
      ...hereBefore.numberHistory,
      { number: 'INV-3000000101', allocatedAt: now, status: 'paid' },
    ])
    expect(bareAfter.invoiceNumber).toBe('INV-3000000102')
    // The number it had is kept, with the day it took it.
    expect(bareAfter.numberHistory).toEqual([
      { number: 'INV-2026-3000000102', allocatedAt: issuedAt, status: 'sent' },
      { number: 'INV-3000000102', allocatedAt: now, status: 'sent' },
    ])
    expect(rest(hereAfter)).toEqual(rest(hereBefore))
    expect(rest(bareAfter)).toEqual(rest(bareBefore))
    // The running number moves with the number: the year leaves the head, the digits stay.
    expect(hereAfter).toMatchObject({ numberHead: 'INV', numberSeq: 3000000101 })
    expect(bareAfter).toMatchObject({ numberHead: 'INV', numberSeq: 3000000102 })
    expect(hereAfter.draftNumber).toBe('DRF-INV-2026-00004')
  })

  it('does not move the series: the next number reads the same before and after', async () => {
    const w = await world()
    await w.holds('INV-3000000100')
    await w.holds('INV-2026-3000000101')
    const before = await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')
    expect(before.next).toBe('INV-3000000102')

    await applyYearlessNumbers(w.orgId, await planYearlessNumbers(w.orgId), { backupPath: w.backup() })
    expect(await peekNextInvoiceNumber(w.orgId, 'outgoing', 'invoice')).toEqual(before)
    expect(await w.numbers()).toEqual(['INV-3000000100', 'INV-3000000101'])
  })

  it('a second run finds nothing to change', async () => {
    const w = await world()
    await w.holds('INV-2026-3000000101')
    await w.holds('INV-2026-3000000102')
    await applyYearlessNumbers(w.orgId, await planYearlessNumbers(w.orgId), { backupPath: w.backup() })

    const again = await planYearlessNumbers(w.orgId)
    expect(again.rename).toEqual([])
    expect(again.left).toEqual([])
    const path = w.backup()
    expect(await applyYearlessNumbers(w.orgId, again, { backupPath: path })).toEqual({ written: 0, raced: 0 })
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('saves the before-values first, and never over a file that is there', async () => {
    const w = await world()
    const a = await w.holds('INV-2026-3000000101', { numberHistory: [{ number: 'INV-2026-3000000101', allocatedAt: new Date('2026-10-05T09:00:00Z'), status: 'sent' }] })
    const plan = await planYearlessNumbers(w.orgId)

    const taken = w.backup()
    writeFileSync(taken, 'an earlier run\n')
    const err = await captureRejection(applyYearlessNumbers(w.orgId, plan, { backupPath: taken }))
    expect(err?.code).toBe('EEXIST')
    expect(readFileSync(taken, 'utf8')).toBe('an earlier run\n')
    expect(await w.numbers()).toEqual(['INV-2026-3000000101'])

    const path = w.backup()
    await applyYearlessNumbers(w.orgId, plan, { backupPath: path })
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l))).toEqual([{
      _id: String(a._id), invoiceNumber: 'INV-2026-3000000101', to: 'INV-3000000101',
      numberHistory: [{ number: 'INV-2026-3000000101', allocatedAt: '2026-10-05T09:00:00.000Z', status: 'sent' }],
    }])
  })

  it('writes a document only while it holds the number the plan read', async () => {
    const w = await world()
    const moved = await w.holds('INV-2026-3000000101')
    const blocked = await w.holds('INV-2026-3000000102')
    await w.holds('INV-2026-3000000103')
    const plan = await planYearlessNumbers(w.orgId)
    // Between the plan and the write: one document's number changes, and another's new number is taken.
    await Invoice.updateOne({ _id: moved._id }, { $set: { invoiceNumber: 'INV-2026-3000000199' } }).exec()
    await w.holds('INV-3000000102')

    const res = await applyYearlessNumbers(w.orgId, plan, { backupPath: w.backup() })
    expect(res).toEqual({ written: 1, raced: 2 })
    expect((await w.doc(moved._id)).invoiceNumber).toBe('INV-2026-3000000199')
    expect((await w.doc(blocked._id)).invoiceNumber).toBe('INV-2026-3000000102')
    expect(await w.numbers()).toEqual(['INV-2026-3000000102', 'INV-2026-3000000199', 'INV-3000000102', 'INV-3000000103'])
  })

  it('never reaches another org', async () => {
    const w = await world()
    const other = await world()
    await w.holds('INV-2026-3000000101')
    await other.holds('INV-2026-3000000101')
    await applyYearlessNumbers(w.orgId, await planYearlessNumbers(w.orgId), { backupPath: w.backup() })
    expect(await w.numbers()).toEqual(['INV-3000000101'])
    expect(await other.numbers()).toEqual(['INV-2026-3000000101'])
  })
})

describe('a restore', () => {
  it('puts the numbers and the histories back, and a second one finds nothing to put back', async () => {
    const w = await world()
    const a = await w.holds('INV-2026-3000000101', { numberHistory: [{ number: 'INV-2026-3000000101', allocatedAt: new Date('2026-10-05T09:00:00Z'), status: 'sent' }] })
    const b = await w.holds('INV-2026-3000000102', { numberHistory: [] })
    const [aBefore, bBefore] = [await w.doc(a._id), await w.doc(b._id)]
    const path = w.backup()
    await applyYearlessNumbers(w.orgId, await planYearlessNumbers(w.orgId), { backupPath: path })
    expect(await w.numbers()).toEqual(['INV-3000000101', 'INV-3000000102'])

    // A dry run counts and writes nothing.
    expect(await restoreYearNumbers(w.orgId, path)).toEqual({ lines: 2, restored: 2, skipped: 0 })
    expect(await w.numbers()).toEqual(['INV-3000000101', 'INV-3000000102'])

    expect(await restoreYearNumbers(w.orgId, path, { execute: true })).toEqual({ lines: 2, restored: 2, skipped: 0 })
    const [aAfter, bAfter] = [await w.doc(a._id), await w.doc(b._id)]
    expect([aAfter.invoiceNumber, bAfter.invoiceNumber]).toEqual(['INV-2026-3000000101', 'INV-2026-3000000102'])
    expect(aAfter.numberHistory).toEqual(aBefore.numberHistory)
    expect(bAfter.numberHistory).toEqual(bBefore.numberHistory)
    expect(rest(aAfter)).toEqual(rest(aBefore))

    expect(await restoreYearNumbers(w.orgId, path, { execute: true })).toEqual({ lines: 2, restored: 0, skipped: 2 })
  })

  it('leaves a document that has moved on since the run, and another org\'s', async () => {
    const w = await world()
    const other = await world()
    const a = await w.holds('INV-2026-3000000101')
    const b = await w.holds('INV-2026-3000000102')
    const path = w.backup()
    await applyYearlessNumbers(w.orgId, await planYearlessNumbers(w.orgId), { backupPath: path })
    await Invoice.updateOne({ _id: a._id }, { $set: { invoiceNumber: 'INV-3000000999' } }).exec()

    expect(await restoreYearNumbers(w.orgId, path, { execute: true })).toEqual({ lines: 2, restored: 1, skipped: 1 })
    expect((await w.doc(a._id)).invoiceNumber).toBe('INV-3000000999')
    expect((await w.doc(b._id)).invoiceNumber).toBe('INV-2026-3000000102')
    // The same file pointed at another org finds none of its documents there.
    expect(await restoreYearNumbers(other.orgId, path, { execute: true })).toEqual({ lines: 2, restored: 0, skipped: 2 })
  })
})
