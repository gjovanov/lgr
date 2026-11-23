import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { Invoice } from 'db/models'
import { runMigrations } from 'migrations/runner'
import { importedLineTotalsGross, lineKind } from 'migrations/migrations/0023-imported-line-totals-gross'
import type { Types } from 'mongoose'

/**
 * #598 — an imported invoice's or note's `lineTotal` is gross, as every other document's.
 *
 * The document import stored the paper's NET line value; 0023 adds the line's VAT to it. What matters is
 * what it must NOT touch: a line already gross (a copy carries the `ocr-import` tag, a person saves an imported
 * draft through the form), a line without VAT, a line it cannot read, an LGR-made document beside the imported
 * ones of the same customer, a cash sale (0007/0011's), and the documents' headers. And a second run is a no-op.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const db = () => mongoose.connection.db!
const up = (orgFilter: Record<string, unknown> = {}, log: (m: string) => void = () => {}) =>
  importedLineTotalsGross.up({ db: db(), log, orgFilter })
const lineTotals = async (id: unknown) => ((await Invoice.findById(id).lean()) as any).lines.map((l: any) => l.lineTotal)
const headers = async (id: unknown) => {
  const d = (await Invoice.findById(id).lean()) as any
  return [d.subtotal, d.taxTotal, d.total]
}
const everyLine = async () => (await Invoice.find({}).sort({ _id: 1 }).lean()).map((d: any) => d.lines.map((l: any) => [l.lineTotal, l.taxAmount]))

const line = (quantity: number, unitPrice: number, taxAmount: number, lineTotal: number, over: Record<string, any> = {}) =>
  ({ description: 'x', unit: 'pcs', discount: 0, taxRate: 20, quantity, unitPrice, taxAmount, lineTotal, ...over })

const IMPORTED = { tags: ['ocr-import', 'dir:outgoing'] }

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const contact = await createTestContact(orgId)
  const cid = contact._id as Types.ObjectId
  const doc = (over: Record<string, any>) => createTestInvoice(orgId, cid, { status: 'sent', ...over } as any)

  // What the import stored: the paper's line values, net. 3000 × 0.0213 does not make 64.00, so the import
  // derived the price; and a VAT-free line, where net and gross are one figure.
  const net = await doc({
    ...IMPORTED,
    lines: [line(40, 0.1, 0.8, 4), line(3000, 64 / 3000, 12.8, 64), line(1, 8, 0, 8, { taxRate: 0 })],
    subtotal: 76, taxTotal: 13.6, total: 89.6,
  })
  // A copy of an imported invoice the form saved: tagged, and gross.
  const gross = await doc({ ...IMPORTED, lines: [line(40, 0.1, 0.8, 4.8)], subtotal: 4, taxTotal: 0.8, total: 4.8 })
  // One of each in one document, a few cents included: 0.05 net with 0.01 VAT, and the same line gross.
  const mixed = await doc({
    ...IMPORTED,
    lines: [line(1, 0.05, 0.01, 0.05), line(1, 0.05, 0.01, 0.06), line(40, 0.1, 0.8, 4.8)],
    subtotal: 4.1, taxTotal: 0.82, total: 4.92,
  })
  // A person took the tag off: its first status still says the import wrote it.
  const byStatus = await doc({
    tags: [],
    statusHistory: [{ status: 'draft', changedAt: new Date(), reason: 'ocr_import' }],
    lines: [line(40, 0.1, 0.8, 4)], subtotal: 4, taxTotal: 0.8, total: 4.8,
  })
  // A credit note, stored as positive magnitudes.
  const note = await doc({ ...IMPORTED, type: 'credit_note', lines: [line(40, 0.1, 0.8, 4)], subtotal: 4, taxTotal: 0.8, total: 4.8 })
  // A line with no quantity or price: near neither, left alone and counted; its document's other line converts.
  const odd = await doc({
    ...IMPORTED,
    lines: [line(0, 0, 2, 10), line(40, 0.1, 0.8, 4)], subtotal: 14, taxTotal: 2.8, total: 16.8,
  })
  // LGR-made, same org and customer: gross, and one whose line even LOOKS net. Neither is imported.
  const lgrGross = await doc({ lines: [line(40, 0.1, 0.8, 4.8)], subtotal: 4, taxTotal: 0.8, total: 4.8 })
  const lgrNetLooking = await doc({ lines: [line(5, 2, 2, 10)], subtotal: 10, taxTotal: 2, total: 12 })
  // A cash sale the Files import tagged: 0007/0011 decide those, per document.
  const cashSale = await doc({ ...IMPORTED, type: 'cash_sale', status: 'paid', lines: [line(40, 0.1, 0.8, 4)], subtotal: 4, taxTotal: 0.8, total: 4.8 })
  return { org, orgId, net, gross, mixed, byStatus, note, odd, lgrGross, lgrNetLooking, cashSale }
}

describe('0023-imported-line-totals-gross', () => {
  it('reads a line by its own terms', () => {
    expect(lineKind(line(40, 0.1, 0.8, 4))).toBe('net')
    expect(lineKind(line(40, 0.1, 0.8, 4.8))).toBe('gross')
    expect(lineKind(line(1, 0.05, 0.01, 0.05))).toBe('net')
    expect(lineKind(line(1, 0.05, 0.01, 0.06))).toBe('gross')
    expect(lineKind(line(1, 8, 0, 8, { taxRate: 0 }))).toBe('zeroVat')
    expect(lineKind(line(0, 0, 2, 10))).toBe('neither')
    // A discount comes off the net first, as the forms take it: 2 × 100 − 10 % = 180, VAT 36.
    expect(lineKind(line(2, 100, 36, 180, { discount: 10 }))).toBe('net')
    expect(lineKind(line(2, 100, 36, 216, { discount: 10 }))).toBe('gross')
  })

  it('makes the imported net lines gross, and nothing else', async () => {
    const s = await seed()
    await runMigrations({ db: db(), migrations: [importedLineTotalsGross] })
    expect(await lineTotals(s.net._id)).toEqual([4.8, 76.8, 8])
    expect(await lineTotals(s.gross._id)).toEqual([4.8])
    expect(await lineTotals(s.mixed._id)).toEqual([0.06, 0.06, 4.8])
    expect(await lineTotals(s.byStatus._id)).toEqual([4.8])
    expect(await lineTotals(s.note._id)).toEqual([4.8])
    expect(await lineTotals(s.odd._id)).toEqual([10, 4.8])
    expect(await lineTotals(s.lgrGross._id)).toEqual([4.8])
    expect(await lineTotals(s.lgrNetLooking._id)).toEqual([10])
    expect(await lineTotals(s.cashSale._id)).toEqual([4])
  })

  it('leaves every header as it was', async () => {
    const s = await seed()
    await up()
    expect(await headers(s.net._id)).toEqual([76, 13.6, 89.6])
    expect(await headers(s.mixed._id)).toEqual([4.1, 0.82, 4.92])
    expect(await headers(s.note._id)).toEqual([4, 0.8, 4.8])
    // The VAT is not touched either: the net is lineTotal − taxAmount from now on.
    const d: any = await Invoice.findById(s.net._id).lean()
    expect(d.lines.map((l: any) => l.taxAmount)).toEqual([0.8, 12.8, 0])
    expect(d.lines.map((l: any) => +(l.lineTotal - l.taxAmount).toFixed(2))).toEqual([4, 64, 8])
  })

  it('changes nothing the second time', async () => {
    await seed()
    await up()
    const after = await everyLine()
    const messages: string[] = []
    await up({}, m => { messages.push(m) })
    expect(await everyLine()).toEqual(after)
    expect(messages.at(-1)).toBe('imported documents whose net lines now carry gross line totals: 0 of 0 (0 line(s))')
  })

  it('touches only the orgs in its filter', async () => {
    const a = await seed()
    const b = await seed()
    await up({ orgId: a.orgId })
    expect(await lineTotals(a.net._id)).toEqual([4.8, 76.8, 8])
    expect(await lineTotals(b.net._id)).toEqual([4, 64, 8])
  })

  it('reports per org what it converted and what it left alone', async () => {
    const s = await seed()
    const messages: string[] = []
    await up({}, m => { messages.push(m) })
    expect(messages).toEqual([
      `${s.org.slug}: 5 document(s), 6 line(s) net → gross; left alone: 3 already gross, 1 without VAT, 1 matching neither`,
      'imported documents whose net lines now carry gross line totals: 5 of 5 (6 line(s))',
    ])
    const again: string[] = []
    await up({}, m => { again.push(m) })
    expect(again[0]).toBe(`${s.org.slug}: 0 document(s), 0 line(s) net → gross; left alone: 9 already gross, 1 without VAT, 1 matching neither`)
  })

  it('says in a dry run what it would do, and names the lines it cannot read, writing nothing', async () => {
    const s = await seed()
    const before = await everyLine()
    const lines = await importedLineTotalsGross.preview!({ db: db(), log: () => {}, orgFilter: {} })
    expect(lines).toEqual([
      `${s.org.slug}: 5 document(s), 6 line(s) net → gross; left alone: 3 already gross, 1 without VAT, 1 matching neither`,
      `${s.org.slug}: lines matching neither, in ${s.odd.invoiceNumber}`,
    ])
    expect(await everyLine()).toEqual(before)
  })

  it('leaves a line someone saved between its read and its write', async () => {
    const s = await seed()
    // The write names the values it read: a line that changed since is not overwritten.
    const real = db()
    const invoices = real.collection('invoices')
    const racing = {
      collection: (name: string) => name !== 'invoices' ? real.collection(name) : {
        find: (...a: any[]) => (invoices.find as any)(...a),
        bulkWrite: async (ops: any[], opts: any) => {
          await Invoice.updateOne({ _id: s.byStatus._id }, { $set: { 'lines.0.lineTotal': 5 } })
          return invoices.bulkWrite(ops, opts)
        },
      },
    }
    const messages: string[] = []
    await importedLineTotalsGross.up({ db: racing as any, log: m => { messages.push(m) }, orgFilter: {} })
    expect(await lineTotals(s.byStatus._id)).toEqual([5])
    expect(await lineTotals(s.net._id)).toEqual([4.8, 76.8, 8])
    expect(messages.at(-1)).toBe('imported documents whose net lines now carry gross line totals: 4 of 5 (6 line(s))')
  })
})
