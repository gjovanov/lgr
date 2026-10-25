import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'
import { runMigrations } from 'migrations/runner'
import { cashSaleLineTotalsGross } from 'migrations/migrations/0007-cash-sale-line-totals-gross'
import { mapCashSaleExport } from 'services/biz/doc-import/map-cash-sale'
import { aggregateCashSales } from 'invoicing-api/src/controllers/invoice-export.controller'
import type { Types } from 'mongoose'

/**
 * FR-21.5 — a cash sale's `lineTotal` is gross, as the UI writes it.
 *
 * The till imports wrote the net there, while the FR-03 aggregate reads `lineTotal − taxAmount`
 * as the net: an imported day exported its net as "gross". The importers write gross now, and
 * `0007` converts the lines already booked — per DOCUMENT, so a second run finds nothing to do.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const db = () => mongoose.connection.db!
const migrate = () => runMigrations({ db: db(), migrations: [cashSaleLineTotalsGross] })
const lineTotals = async (id: unknown) => ((await Invoice.findById(id).lean()) as any).lines.map((l: any) => l.lineTotal)

const line = (over: Record<string, any>) => ({ description: 'x', unit: 'pcs', discount: 0, taxRate: 20, ...over })

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const contact = await createTestContact(orgId)
  const cid = contact._id as Types.ObjectId
  const doc = (over: Record<string, any>) => createTestInvoice(orgId, cid, {
    type: 'cash_sale', direction: 'outgoing', status: 'paid', ...over,
  } as any)

  // A till import as it was booked: net line values summing to the subtotal.
  const imported = await doc({
    tags: ['cash-register-import'], reference: 'salesAnalysis:2026-05-10',
    lines: [
      line({ quantity: 2, unitPrice: 5, taxAmount: 2, lineTotal: 10 }),
      line({ quantity: 3, unitPrice: 1.1111, taxAmount: 0.67, lineTotal: 3.33 }),
    ],
    subtotal: 13.33, taxTotal: 2.67, total: 16,
  })
  // What the cash-sale terminal writes: gross lines.
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
  return { orgId, imported, fromUi, vatFree, discounted, invoice }
}

describe('0007-cash-sale-line-totals-gross', () => {
  it('converts an imported day to gross lines, and nothing else', async () => {
    const s = await seed()
    await migrate()
    expect(await lineTotals(s.imported._id)).toEqual([12, 4])
    expect(await lineTotals(s.fromUi._id)).toEqual([12])
    expect(await lineTotals(s.vatFree._id)).toEqual([8])
    expect(await lineTotals(s.discounted._id)).toEqual([8])
    expect(await lineTotals(s.invoice._id)).toEqual([10])
    // The document's own totals were always right.
    const doc = (await Invoice.findById(s.imported._id).lean()) as any
    expect([doc.subtotal, doc.taxTotal, doc.total]).toEqual([13.33, 2.67, 16])
  })

  it('changes nothing the second time', async () => {
    const s = await seed()
    await migrate()
    await cashSaleLineTotalsGross.up({ db: db(), log: () => {}, orgFilter: {} })
    expect(await lineTotals(s.imported._id)).toEqual([12, 4])
  })

  it('touches only the orgs in its filter', async () => {
    const a = await seed()
    const b = await seed()
    await cashSaleLineTotalsGross.up({ db: db(), log: () => {}, orgFilter: { orgId: a.orgId } })
    expect(await lineTotals(a.imported._id)).toEqual([12, 4])
    expect(await lineTotals(b.imported._id)).toEqual([10, 3.33])
  })

  it('after it, the FR-03 aggregate reports an imported day\'s net and gross correctly', async () => {
    const s = await seed()
    await migrate()
    const { sections } = await aggregateCashSales({ _id: s.imported._id })
    const rows = sections[0].rows
    const net = rows.reduce((t: number, r: any) => t + r.netTotal, 0)
    const gross = rows.reduce((t: number, r: any) => t + r.grossTotal, 0)
    expect(Math.round(net * 100) / 100).toBe(13.33)
    expect(Math.round(gross * 100) / 100).toBe(16)
  })
})

describe('the till import writes gross lines (map-cash-sale)', () => {
  it('lineTotal is net + VAT; the subtotal stays the net of the export', async () => {
    const org = await createTestOrg()
    const orgId = org._id as Types.ObjectId
    const wh = await createTestWarehouse(orgId)
    await createTestProduct(orgId, { name: 'Bolt M8', unit: 'pcs' })
    const { mapped } = await mapCashSaleExport(String(orgId), {
      rows: [{ name: 'Bolt M8', qty: 2, value: 10 }, { name: 'Unknown thing', qty: 1, value: 3.33 }],
    }, { date: '2026-05-10', warehouseId: String(wh._id) })

    expect(mapped.lines.map(l => [l.lineTotal, l.taxAmount])).toEqual([[12, 2], [4, 0.67]])
    expect([mapped.subtotal, mapped.taxTotal, mapped.total]).toEqual([13.33, 2.67, 16])
  })
})
