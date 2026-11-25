import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { Org, StockMovement, VatRegisterEntry } from 'db/models'
import { PurchasePairingError } from 'services/biz/accounting-books/purchases/pairing.service'
import { pairPurchaseReceiptsOf } from 'services/biz/accounting-books/purchases/receipt-pairing.service'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestStockMovement } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * FR-25 R4, slice 2: a filed month's purchase register in the home of a split, against the goods receipts of the home
 * and the store, read-only. Made-up orgs, partners, numbers and amounts only.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const PERIOD = '202609'
const day = (iso: string) => new Date(`${iso}T08:00:00.000Z`)
let home: any, store: any

const filedRow = (rowNo: number, over: Record<string, unknown>) => ({
  orgId: home._id, period: PERIOD, side: 'purchase', ledger: 'books', rowNo, frozen: true,
  docTypeCode: '01', docNumber: `00000009${String(rowNo).padStart(2, '0')}`, docDate: new Date('2026-09-10T00:00:00.000Z'),
  partnerVat: 'BG999000191', cells: { '03-31': 1000, '03-41': 200 }, ...over,
})

let seq = 0
const movement = (org: any, over: Record<string, unknown>) =>
  createTestStockMovement(org._id, {
    movementNumber: `MOV-T${++seq}`, type: 'receipt', status: 'completed', date: day('2026-09-10'), totalAmount: 10,
    notes: `Доставки — 2026-09-10 — ТЕСТ ДОСТАВЧИК (stokrazp:30000000${String(seq).padStart(2, '0')})`, ...over,
  } as any)

beforeAll(async () => {
  await setupTestDB()
  home = await createTestOrg({ name: 'Дом', slug: 'prp-home-test', taxNumber: '999000999' } as any)
  store = await createTestOrg({ name: 'Магазин', slug: 'prp-store-test', taxNumber: '999000999' } as any)
  const split = {
    mode: 'books',
    branches: [{ orgId: home._id, code: 'HM', label: 'Дом', docSeries: ['9100'] }, { orgId: store._id, code: 'ST', label: 'Магазин', docSeries: ['9200'] }],
    split: { homeOrgId: home._id },
  }
  await Org.updateMany({ _id: { $in: [home._id, store._id] } }, { $set: { 'settings.accounting.books': split } })

  const supplier = await createTestContact(home._id, { type: 'supplier', companyName: 'ТЕСТ ДОСТАВЧИК ООД', taxId: '999000191', vatNumber: 'BG999000191' } as any)
  const storeSupplier = await createTestContact(store._id, { type: 'supplier', companyName: 'ТЕСТ ДОСТАВЧИК ООД', taxId: '999000191' } as any)
  const customer = await createTestContact(store._id, { type: 'customer', companyName: 'ТЕСТ КЛИЕНТ', taxId: '999000205' } as any)
  const ownStore = await createTestContact(store._id, { type: 'supplier', companyName: 'ДОМ ЕООД', taxId: '999000999' } as any)
  const sale = await createTestInvoice(store._id, customer._id, { status: 'voided', invoiceNumber: 'INV-T1', issueDate: day('2026-09-12') } as any)

  // One to one, in the home.
  await movement(home, { contactId: supplier._id })
  // Summed across the two stores: 15 + 15 for a row of 30, on two days.
  await movement(home, { contactId: supplier._id, totalAmount: 15, date: day('2026-09-16') })
  await movement(store, { contactId: storeSupplier._id, totalAmount: 15, date: day('2026-09-17') })
  // A receipt keyed with VAT: 24 against a row of 20 + 4.
  await movement(store, { contactId: storeSupplier._id, totalAmount: 24, date: day('2026-09-22') })
  // A return, the negative half of the store's разписка, for a credit note.
  await movement(store, { contactId: storeSupplier._id, totalAmount: 50, date: day('2026-09-05'), notes: 'Доставки — 2026-09-05 — ТЕСТ ДОСТАВЧИК (stokrazp:3000000777)' })
  await movement(store, { type: 'adjustment', totalAmount: 5, date: day('2026-09-05'), notes: 'Корекция от стокова разписка — 2026-09-05 (stokrazp:3000000777)' })
  // Left out: a sale taken back, a correction, a delivery from the other store, a draft.
  await movement(store, { contactId: customer._id, invoiceId: sale._id, notes: 'Reversal for voided invoice INV-T1' })
  await movement(home, { notes: 'Доставки — 2026-09-10 — 2000 КОРЕКЦИЯ (stokrazp:3000000888)' })
  await movement(store, { contactId: ownStore._id })
  await movement(home, { contactId: supplier._id, status: 'draft' })
  // Declared late: a receipt of the month in October's register; and one in no register.
  await movement(home, { contactId: supplier._id, totalAmount: 33, date: day('2026-09-29') })
  await movement(home, { contactId: supplier._id, totalAmount: 77, date: day('2026-09-25') })

  await VatRegisterEntry.insertMany([
    filedRow(1, {}),
    filedRow(2, { docDate: new Date('2026-09-17T00:00:00.000Z'), cells: { '03-31': 3000, '03-41': 600 } }),
    filedRow(3, { docDate: new Date('2026-09-22T00:00:00.000Z'), cells: { '03-31': 2000, '03-41': 400 } }),
    filedRow(4, { docTypeCode: '03', docDate: new Date('2026-09-20T00:00:00.000Z'), cells: { '03-31': -500, '03-41': -100 } }),
    // A service with no delivery, a protocol, and a supplier with no receipt in the year.
    filedRow(5, { cells: { '03-31': 4400, '03-41': 880 } }),
    filedRow(6, { docTypeCode: '09', partnerVat: 'DE999999999' }),
    filedRow(7, { partnerVat: 'BG999000213' }),
    // October's register, and a sales row of September: neither is September's purchase register.
    filedRow(1, { period: '202610', docDate: new Date('2026-10-01T00:00:00.000Z'), cells: { '03-31': 3300, '03-41': 660 } }),
    filedRow(8, { side: 'sales', docNumber: '9100000001', cells: { '02-10': 1000, '02-20': 200 } }),
  ])
})

afterAll(async () => {
  await teardownTestDB()
})

describe("FR-25 R4, slice 2 — a filed month of purchases against the stores' receipts", () => {
  it('counts every outcome, from either org of the split', async () => {
    const r = await pairPurchaseReceiptsOf(String(store._id), PERIOD)
    expect(r.home).toBe('prp-home-test')
    expect(r.stores).toEqual(['HM', 'ST'])
    expect(r.rows).toEqual({ total: 7, byType: { '01': 5, '03': 1, '09': 1 }, datedEarlier: 0, datedLater: 0 })
    expect(r.month.receipts).toBe(11)
    expect(r.month.receiptsByOrg).toEqual({ HM: 6, ST: 5 })
    expect(r.month.excluded).toMatchObject({ 'not booked': 1, 'sale taken back': 1, correction: 1, 'the company itself': 1 })
    expect(r.month.deliveries).toBe(7)
    expect(r.month).toMatchObject({ returns: 1, returnsKept: 1 })
    expect(r.paired).toMatchObject({
      total: 4, oneToOne: { net: 2, gross: 1 }, summed: { net: 1, gross: 0 }, creditOneToOne: 1, acrossStores: 1,
    })
    expect(r.rowsUnpaired).toMatchObject({ total: 3, byType: { '01': 2, '09': 1 }, partnerHasReceipts: 1, partnerHasNone: 1 })
    expect(r.receiptsOfMonth).toEqual({ inPeriod: 4, later: 1, notDeclared: 2 })
    expect(r.returnsOfMonth).toEqual({ inPeriod: 1, later: 0, notDeclared: 0 })
    expect(r.laterPeriods).toEqual({ first: '202610', last: '202610', rows: 1 })
  })

  it('writes nothing', async () => {
    const before = [await StockMovement.countDocuments({}), await VatRegisterEntry.countDocuments({})]
    const stamps = (await StockMovement.find({}).select('updatedAt').lean<any[]>()).map(d => String(d.updatedAt)).sort()
    await pairPurchaseReceiptsOf(String(home._id), PERIOD)
    expect([await StockMovement.countDocuments({}), await VatRegisterEntry.countDocuments({})]).toEqual(before)
    expect((await StockMovement.find({}).select('updatedAt').lean<any[]>()).map(d => String(d.updatedAt)).sort()).toEqual(stamps)
  })

  it('refuses a period that is not one', async () => {
    const bad = await captureRejection(pairPurchaseReceiptsOf(String(home._id), '2026-09'))
    expect(bad).toBeInstanceOf(PurchasePairingError)
    expect((bad as PurchasePairingError).code).toBe('bad_period')
  })

  it('the script prints counts only, and names identifiers only with --details', async () => {
    const run = async (...extra: string[]) => {
      const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'pair-purchase-receipts.ts'), '--org', 'prp-home-test', '--period', PERIOD, ...extra], {
        cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { out, err, code }
    }
    const plain = await run()
    expect([plain.code, plain.code ? plain.out + plain.err : '']).toEqual([0, ''])
    expect(plain.out).toContain('Read-only, a dry run with nothing to execute')
    expect(plain.out).toMatch(/\s7 {2}rows/)
    expect(plain.out).toMatch(/\s4 {2}rows paired/)
    expect(plain.out).toMatch(/\s1 {4}09 protocol or other/)
    expect(plain.out).not.toContain('00000009')
    expect(plain.out).not.toContain('999000191')
    expect(plain.out).not.toContain('MOV-T')
    expect(plain.out).not.toContain('stokrazp')
    expect(plain.out).not.toMatch(/\d+\.\d{2}/)

    const withDetails = await run('--details')
    expect(withDetails.code).toBe(0)
    expect(withDetails.out).toContain('never paste them into the repo')
    expect(withDetails.out).toContain('MOV-T')

    const help = await run('--execute')
    expect(help.code).toBe(2)
    expect(help.err).toContain('There is no --execute')
  })
})
