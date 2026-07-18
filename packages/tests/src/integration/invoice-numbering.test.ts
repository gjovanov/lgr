import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { Invoice, Sequence } from 'db/models'
import { getNextNumber } from 'services/biz/sequence.service'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * These tests exercise the Phase 2 invariants directly via the SequenceService,
 * mirroring how invoice.controller.ts generates numbers:
 *   - INV, CRN, DBN share a single `SALES_DOC` counter per org/year.
 *   - PROFORMA, CASH_SALE, BILL use independent counters.
 *   - Concurrent allocations are atomic and never collide.
 */
describe('Invoice numbering', () => {
  it('INV / CRN / DBN share the SALES_DOC counter', async () => {
    const org = await createTestOrg()
    const year = new Date().getFullYear()

    const n1 = await getNextNumber(String(org._id), 'SALES_DOC', 5, year)
    const n2 = await getNextNumber(String(org._id), 'SALES_DOC', 5, year)
    const n3 = await getNextNumber(String(org._id), 'SALES_DOC', 5, year)

    expect(n1.endsWith('00001')).toBe(true)
    expect(n2.endsWith('00002')).toBe(true)
    expect(n3.endsWith('00003')).toBe(true)
  })

  it('PROFORMA, CASH_SALE, BILL are independent from SALES_DOC', async () => {
    const org = await createTestOrg()
    const year = new Date().getFullYear()

    await getNextNumber(String(org._id), 'SALES_DOC', 5, year)
    await getNextNumber(String(org._id), 'SALES_DOC', 5, year)

    const pf = await getNextNumber(String(org._id), 'PROFORMA', 5, year)
    const cs = await getNextNumber(String(org._id), 'CASH_SALE', 5, year)
    const bl = await getNextNumber(String(org._id), 'BILL', 5, year)

    expect(pf.endsWith('00001')).toBe(true)
    expect(cs.endsWith('00001')).toBe(true)
    expect(bl.endsWith('00001')).toBe(true)
  })

  it('concurrent allocations are race-safe (no duplicates)', async () => {
    const org = await createTestOrg()
    const year = new Date().getFullYear()
    const N = 50

    const results = await Promise.all(
      Array.from({ length: N }, () => getNextNumber(String(org._id), 'SALES_DOC', 5, year)),
    )
    const unique = new Set(results)
    expect(unique.size).toBe(N)
    const counter = await Sequence.findOne({ orgId: org._id, prefix: 'SALES_DOC', year }).lean()
    expect(counter?.lastNumber).toBe(N)
  })

  it('counter is isolated per org', async () => {
    const orgA = await createTestOrg({ slug: 'num-a' })
    const orgB = await createTestOrg({ slug: 'num-b' })
    const year = new Date().getFullYear()

    const a1 = await getNextNumber(String(orgA._id), 'SALES_DOC', 5, year)
    const b1 = await getNextNumber(String(orgB._id), 'SALES_DOC', 5, year)
    const a2 = await getNextNumber(String(orgA._id), 'SALES_DOC', 5, year)

    expect(a1.endsWith('00001')).toBe(true)
    expect(a2.endsWith('00002')).toBe(true)
    expect(b1.endsWith('00001')).toBe(true)
  })

  it('unique invoiceNumber index prevents duplicates per org', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)

    const baseInv = {
      orgId: org._id,
      type: 'invoice',
      direction: 'outgoing',
      contactId: contact._id,
      issueDate: new Date(),
      dueDate: new Date(),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [],
      subtotal: 0,
      taxTotal: 0,
      total: 0,
      totalBase: 0,
      amountPaid: 0,
      amountDue: 0,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      createdBy: user._id,
      status: 'draft',
    } as any

    await Invoice.create({ ...baseInv, invoiceNumber: 'INV-2026-00001' })
    // try/catch instead of `.rejects` — on Windows, Bun 1.3.12's `.rejects` matcher
    // deadlocks when the rejection follows MongoDB driver I/O.
    let dupErr: any = null
    try {
      await Invoice.create({ ...baseInv, invoiceNumber: 'INV-2026-00001' })
    } catch (e) {
      dupErr = e
    }
    expect(dupErr).toBeTruthy()
  })
})
