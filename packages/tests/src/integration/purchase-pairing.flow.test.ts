import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import type { Types } from 'mongoose'
import { Invoice, Org, VatRegisterEntry } from 'db/models'
import { PurchasePairingError, pairPurchasesOf, purchaseOrgsOf } from 'services/biz/accounting-books/purchases/pairing.service'
import { setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * FR-25 R4, slice 1: a filed month's purchase register in the home of a split, against the bills of the home and the
 * store, read-only. Made-up orgs, partners, numbers and amounts only.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const PERIOD = '202609'
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
let home: any, store: any, supplier: any, storeSupplier: any, unnumbered: any

const filedRow = (rowNo: number, over: Record<string, unknown>) => ({
  orgId: home._id, period: PERIOD, side: 'purchase', ledger: 'books', rowNo, frozen: true,
  docTypeCode: '01', docDate: day('2026-09-10'), partnerVat: 'BG999000191', cells: { '03-31': 1000, '03-41': 200 }, ...over,
})

let seq = 0
/** A received bill of 10.00 + 2.00 VAT, unless told otherwise. */
const received = (org: any, contactId: Types.ObjectId, over: Record<string, unknown>) =>
  createTestInvoice(org._id, contactId, {
    direction: 'incoming', status: 'received', invoiceNumber: `BILL-T${++seq}`, issueDate: day('2026-09-10'),
    subtotal: 10, taxTotal: 2, total: 12, totalBase: 12, ...over,
  } as any)

beforeAll(async () => {
  await setupTestDB()
  home = await createTestOrg({ name: 'Дом', slug: 'pp-home-test' } as any)
  store = await createTestOrg({ name: 'Магазин', slug: 'pp-store-test' } as any)
  const split = {
    mode: 'books',
    branches: [{ orgId: home._id, code: 'HM', label: 'Дом', docSeries: ['9100'] }, { orgId: store._id, code: 'ST', label: 'Магазин', docSeries: ['9200'] }],
    split: { homeOrgId: home._id },
  }
  await Org.updateMany({ _id: { $in: [home._id, store._id] } }, { $set: { 'settings.accounting.books': split } })

  supplier = await createTestContact(home._id, { type: 'supplier', companyName: 'ТЕСТ ДОСТАВЧИК ООД', taxId: '999000191', vatNumber: 'BG999000191' } as any)
  storeSupplier = await createTestContact(store._id, { type: 'supplier', companyName: 'ТЕСТ ДОСТАВЧИК ООД', taxId: '999000191', vatNumber: undefined } as any)
  unnumbered = await createTestContact(store._id, { type: 'supplier', companyName: 'ТЕСТ БЕЗ НОМЕР', taxId: undefined, vatNumber: undefined } as any)

  // Exactly: one in the home, one in the store (whose contact holds only the ЕИК), one through the document import.
  await received(home, supplier._id, { reference: '0000000101' })
  await received(store, storeSupplier._id, { reference: '0000000102', issueDate: day('2026-09-11'), tags: ['ocr-import'] })
  // A credit note: negative in the register, positive in LGR.
  await received(store, storeSupplier._id, { type: 'credit_note', reference: '0000000103', subtotal: 5, taxTotal: 1, total: 6, totalBase: 6 })
  // Differs: the amounts; the number as written; the partner (a supplier with no number).
  await received(home, supplier._id, { reference: '0000000104', subtotal: 20, taxTotal: 4, total: 24, totalBase: 24 })
  await received(home, supplier._id, { reference: '105' })
  await received(store, unnumbered._id, { reference: '0000000106' })
  // Declared late: dated in June, filed in September.
  await received(home, supplier._id, { reference: '0000000107', issueDate: day('2026-06-15') })
  // A draft only, for a filed row.
  await received(home, supplier._id, { reference: '0000000108', status: 'draft', invoiceNumber: 'DRF-BILL-T1' })
  // Bills with no row of September: one in August's register, one in none.
  await received(home, supplier._id, { reference: '0000000109' })
  await received(store, storeSupplier._id, { reference: '0000000110' })
  // Not a bill: an outgoing invoice of the same number, and a bill of another year.
  await createTestInvoice(home._id, supplier._id, { status: 'sent', reference: '0000000101', invoiceNumber: 'INV-T1', issueDate: day('2026-09-10') } as any)
  await received(home, supplier._id, { reference: '0000000111', issueDate: day('2024-09-10') })

  await VatRegisterEntry.insertMany([
    filedRow(1, { docNumber: '0000000101' }),
    filedRow(2, { docNumber: '0000000102', docDate: day('2026-09-11') }),
    filedRow(3, { docTypeCode: '03', docNumber: '0000000103', cells: { '03-31': -500, '03-41': -100 } }),
    filedRow(4, { docNumber: '0000000104' }),
    filedRow(5, { docNumber: '0000000105' }),
    filedRow(6, { docNumber: '0000000106' }),
    filedRow(7, { docNumber: '0000000107', docDate: day('2026-06-15') }),
    filedRow(8, { docNumber: '0000000108' }),
    // What R4 has to create: a protocol for an EU purchase and a customs declaration.
    filedRow(9, { docTypeCode: '09', docNumber: '0000000012', partnerVat: 'DE999999999' }),
    filedRow(10, { docTypeCode: '07', docNumber: '26BG000000000001', partnerVat: '999999999999999' }),
    // August's register, and a sales row of September: neither is September's purchase register.
    filedRow(1, { period: '202608', docNumber: '0000000109' }),
    filedRow(1, { side: 'sales', docNumber: '9100000001', cells: { '02-10': 1000, '02-20': 200 } }),
  ])
})

afterAll(async () => {
  await teardownTestDB()
})

describe('FR-25 R4, slice 1 — a filed month of purchases against LGR\'s bills', () => {
  it('reads the register in the home and the bills in every org of the split, from either org', async () => {
    const fromStore = await purchaseOrgsOf(String(store._id))
    expect(fromStore.home.label).toBe('pp-home-test')
    expect(fromStore.billOrgs.map(o => o.label)).toEqual(['HM', 'ST'])
    const own = await createTestOrg({ slug: 'pp-own-test' } as any)
    const alone = await purchaseOrgsOf(String(own._id))
    expect(alone.billOrgs.map(o => o.label)).toEqual(['pp-own-test'])
  })

  it('counts every outcome', async () => {
    const r = await pairPurchasesOf(String(store._id), PERIOD)
    expect(r.home).toBe('pp-home-test')
    expect(r.currency).toBe('EUR')
    expect(r.rows).toEqual({ total: 10, byType: { '01': 7, '03': 1, '07': 1, '09': 1 } })
    expect(r.bills).toEqual({ inPeriod: 8, byOrg: { HM: 4, ST: 4 }, byType: { '01': 7, '03': 1 }, ocr: 1, noNumber: 0, noPartner: 1, converted: 0, drafts: 1, voided: 0 })
    expect(r.paired.exactly).toBe(3)
    expect(r.paired.withDifferences).toBe(4)
    expect(r.paired.byKind).toEqual({ amount: 1, sign: 0, currency: 0, date: 0, type: 0, 'number format': 1, period: 1, number: 0, partner: 1 })
    expect(r.paired.billOfEarlierPeriod).toBe(1)
    expect(r.rowsWithoutBill).toEqual({ total: 3, byType: { '01': 1, '07': 1, '09': 1 }, draftOnly: 1, voidedOnly: 0 })
    expect(r.billsWithoutRow).toEqual({ total: 2, byType: { '01': 2 }, inEarlierRegister: 1, inLaterRegister: 0, inNoRegister: 1 })
    expect(r.otherPeriods).toEqual({ first: '202509', last: '202709', rows: 1 })
  })

  it('writes nothing', async () => {
    const before = [await Invoice.countDocuments({}), await VatRegisterEntry.countDocuments({})]
    const stamps = (await Invoice.find({}).select('updatedAt').lean<any[]>()).map(d => String(d.updatedAt)).sort()
    await pairPurchasesOf(String(home._id), PERIOD)
    expect([await Invoice.countDocuments({}), await VatRegisterEntry.countDocuments({})]).toEqual(before)
    expect((await Invoice.find({}).select('updatedAt').lean<any[]>()).map(d => String(d.updatedAt)).sort()).toEqual(stamps)
  })

  it('refuses a period that is not one', async () => {
    const bad = await captureRejection(pairPurchasesOf(String(home._id), '2026-09'))
    expect(bad).toBeInstanceOf(PurchasePairingError)
    expect((bad as PurchasePairingError).code).toBe('bad_period')
  })

  it('the script prints counts only, and names identifiers only with --details', async () => {
    const run = async (...extra: string[]) => {
      const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'pair-purchases.ts'), '--org', 'pp-home-test', '--period', PERIOD, ...extra], {
        cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { out, err, code }
    }
    const plain = await run()
    expect([plain.code, plain.code ? plain.out + plain.err : '']).toEqual([0, ''])
    expect(plain.out).toContain('Read-only, a dry run with nothing to execute')
    expect(plain.out).toMatch(/\s10 {2}rows/)
    expect(plain.out).toMatch(/\s3 {2}exactly/)
    expect(plain.out).toMatch(/\s1 {4}07 customs declaration/)
    expect(plain.out).toMatch(/\s1 {4}09 protocol or other/)
    expect(plain.out).toContain("The register against LGR's bills: not equal")
    expect(plain.out).not.toContain('0000000')
    expect(plain.out).not.toContain('999000191')
    expect(plain.out).not.toContain('BILL-')
    expect(plain.out).not.toMatch(/\d+\.\d{2}/)

    const withDetails = await run('--details')
    expect(withDetails.code).toBe(0)
    expect(withDetails.out).toContain('never paste them into the repo')
    expect(withDetails.out).toContain('0000000104')

    const help = await run('--execute')
    expect(help.code).toBe(2)
    expect(help.err).toContain('There is no --execute')
  })
})
