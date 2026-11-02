import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'
import { runMigrations } from 'migrations/runner'
import { cashSaleLineTotalsGross } from 'migrations/migrations/0007-cash-sale-line-totals-gross'
import { cashSaleLineTotalsGrossLate } from 'migrations/migrations/0011-cash-sale-line-totals-gross-late'
import type { Types } from 'mongoose'

/**
 * FR-21.5 again — the cash sales the PlusMinus API import booked after 0007 ran.
 *
 * The API importer wrote the NET line value into `lineTotal` until it was fixed, so a day booked in
 * between is net although 0007 had already run. 0011 applies 0007's per-document rule to it. What
 * matters about a REPEAT is that it never disturbs what 0007 left right: a converted document is
 * not converted twice, and the two migrations do not undo each other.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const db = () => mongoose.connection.db!
const migrate = () => runMigrations({ db: db(), migrations: [cashSaleLineTotalsGrossLate] })
const lineTotals = async (id: unknown) => ((await Invoice.findById(id).lean()) as any).lines.map((l: any) => l.lineTotal)
const totals = async (id: unknown) => {
  const d = (await Invoice.findById(id).lean()) as any
  return [d.subtotal, d.taxTotal, d.total]
}

const line = (over: Record<string, any>) => ({ description: 'x', unit: 'pcs', discount: 0, taxRate: 20, ...over })

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const contact = await createTestContact(orgId)
  const cid = contact._id as Types.ObjectId
  const doc = (over: Record<string, any>) => createTestInvoice(orgId, cid, {
    type: 'cash_sale', direction: 'outgoing', status: 'paid', ...over,
  } as any)

  // A day the API importer booked before its fix: net line values, summing exactly to the subtotal.
  const lateNet = await doc({
    reference: 'posReceipts:2026-10-27',
    lines: [
      line({ quantity: 2, unitPrice: 5, taxAmount: 2, lineTotal: 10 }),
      line({ quantity: 3, unitPrice: 1.1111, taxAmount: 0.67, lineTotal: 3.33 }),
    ],
    subtotal: 13.33, taxTotal: 2.67, total: 16,
  })
  // The same day once 0007 (or the fixed importer) has written it: gross lines.
  const gross = await doc({
    lines: [
      line({ quantity: 2, unitPrice: 5, taxAmount: 2, lineTotal: 12 }),
      line({ quantity: 3, unitPrice: 1.1111, taxAmount: 0.67, lineTotal: 4 }),
    ],
    subtotal: 13.33, taxTotal: 2.67, total: 16,
  })
  // What the cash-sale terminal writes.
  const fromUi = await doc({
    lines: [line({ quantity: 2, unitPrice: 5, taxAmount: 2, lineTotal: 12 })],
    subtotal: 10, taxTotal: 2, total: 12,
  })
  // VAT-free: net and gross are the same, nothing to do.
  const vatFree = await doc({
    lines: [line({ quantity: 1, unitPrice: 8, taxRate: 0, taxAmount: 0, lineTotal: 8 })],
    subtotal: 8, taxTotal: 0, total: 8,
  })
  // A discounted line is none of the importers'.
  const discounted = await doc({
    lines: [line({ quantity: 1, unitPrice: 10, discount: 20, taxAmount: 1.6, lineTotal: 8 })],
    subtotal: 8, taxTotal: 1.6, total: 9.6,
  })
  // Not a cash sale.
  const invoice = await createTestInvoice(orgId, cid, {
    lines: [line({ quantity: 1, unitPrice: 10, taxAmount: 2, lineTotal: 10 })],
    subtotal: 10, taxTotal: 2, total: 12,
  } as any)
  return { orgId, lateNet, gross, fromUi, vatFree, discounted, invoice }
}

describe('0011-cash-sale-line-totals-gross-late', () => {
  it('converts a day the importer booked net, and nothing else', async () => {
    const s = await seed()
    await migrate()
    expect(await lineTotals(s.lateNet._id)).toEqual([12, 4])
    expect(await lineTotals(s.gross._id)).toEqual([12, 4])
    expect(await lineTotals(s.fromUi._id)).toEqual([12])
    expect(await lineTotals(s.vatFree._id)).toEqual([8])
    expect(await lineTotals(s.discounted._id)).toEqual([8])
    expect(await lineTotals(s.invoice._id)).toEqual([10])
    // The document's own totals were always right, and stay so.
    expect(await totals(s.lateNet._id)).toEqual([13.33, 2.67, 16])
  })

  it('changes nothing the second time', async () => {
    const s = await seed()
    await migrate()
    await cashSaleLineTotalsGrossLate.up({ db: db(), log: () => {}, orgFilter: {} })
    expect(await lineTotals(s.lateNet._id)).toEqual([12, 4])
  })

  it('does not undo or repeat 0007, in either order', async () => {
    const s = await seed()
    await cashSaleLineTotalsGross.up({ db: db(), log: () => {}, orgFilter: {} })
    expect(await lineTotals(s.lateNet._id)).toEqual([12, 4])
    await cashSaleLineTotalsGrossLate.up({ db: db(), log: () => {}, orgFilter: {} })
    expect(await lineTotals(s.lateNet._id)).toEqual([12, 4])
    expect(await lineTotals(s.gross._id)).toEqual([12, 4])

    const t = await seed()
    await cashSaleLineTotalsGrossLate.up({ db: db(), log: () => {}, orgFilter: { orgId: t.orgId } })
    await cashSaleLineTotalsGross.up({ db: db(), log: () => {}, orgFilter: { orgId: t.orgId } })
    expect(await lineTotals(t.lateNet._id)).toEqual([12, 4])
  })

  it('touches only the orgs in its filter', async () => {
    const a = await seed()
    const b = await seed()
    await cashSaleLineTotalsGrossLate.up({ db: db(), log: () => {}, orgFilter: { orgId: a.orgId } })
    expect(await lineTotals(a.lateNet._id)).toEqual([12, 4])
    expect(await lineTotals(b.lateNet._id)).toEqual([10, 3.33])
  })

  it('reports how many documents it converted', async () => {
    await seed()
    await seed()
    const messages: string[] = []
    await cashSaleLineTotalsGrossLate.up({ db: db(), log: m => { messages.push(m) }, orgFilter: {} })
    expect(messages).toEqual(['cash sales whose lines now carry gross line totals: 2'])
  })
})
