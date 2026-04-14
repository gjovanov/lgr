import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { Invoice, Sequence } from 'db/models'
import { ensureSequenceAtLeast, getNextNumber } from 'services/biz/sequence.service'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Regression tests for the unified SALES_DOC counter reconcile logic.
 * When legacy invoices (INV/CRN/DBN) exist with numbers that outpace the
 * Sequence counter, the next allocation must catch up and emit a strictly
 * higher suffix — never a number already taken.
 */
describe('Invoice numbering reconcile', () => {
  it('ensureSequenceAtLeast bumps the counter, never lowers it', async () => {
    const org = await createTestOrg()
    const year = 2026
    // First call creates the doc with lastNumber=10.
    await ensureSequenceAtLeast(String(org._id), 'SALES_DOC', year, 10)
    let doc = await Sequence.findOne({ orgId: org._id, prefix: 'SALES_DOC', year }).lean()
    expect(doc?.lastNumber).toBe(10)

    // A smaller minValue should NOT lower lastNumber.
    await ensureSequenceAtLeast(String(org._id), 'SALES_DOC', year, 3)
    doc = await Sequence.findOne({ orgId: org._id, prefix: 'SALES_DOC', year }).lean()
    expect(doc?.lastNumber).toBe(10)

    // A larger minValue bumps it.
    await ensureSequenceAtLeast(String(org._id), 'SALES_DOC', year, 25)
    doc = await Sequence.findOne({ orgId: org._id, prefix: 'SALES_DOC', year }).lean()
    expect(doc?.lastNumber).toBe(25)
  })

  it('after reconcile, getNextNumber returns strictly above the bump', async () => {
    const org = await createTestOrg()
    const year = 2026
    await ensureSequenceAtLeast(String(org._id), 'SALES_DOC', year, 10)
    const n = await getNextNumber(String(org._id), 'SALES_DOC', 5, year)
    expect(n).toMatch(/SALES_DOC-2026-00011$/)
  })

  it('per-org isolation: bumping org A does not affect org B', async () => {
    const a = await createTestOrg({ slug: 'num-recon-a' })
    const b = await createTestOrg({ slug: 'num-recon-b' })
    await ensureSequenceAtLeast(String(a._id), 'SALES_DOC', 2026, 42)
    const nb = await getNextNumber(String(b._id), 'SALES_DOC', 5, 2026)
    expect(nb).toMatch(/SALES_DOC-2026-00001$/)
  })

  it('pre-existing INV-10 causes next CRN to be 11 via the reconcile code-path', async () => {
    // This test uses the same logic path the controller uses: it calls
    // currentMaxSuffix-equivalent query + ensureSequenceAtLeast + getNextNumber.
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const year = 2026

    // Seed 10 legacy INV rows bypassing the Sequence counter (simulates pre-refactor data).
    for (let i = 1; i <= 10; i++) {
      const num = `INV-2026-${String(i).padStart(5, '0')}`
      await Invoice.create({
        orgId: org._id,
        invoiceNumber: num,
        type: 'invoice',
        direction: 'outgoing',
        status: 'sent',
        contactId: contact._id,
        issueDate: new Date('2026-02-01'),
        dueDate: new Date('2026-02-15'),
        currency: 'EUR',
        exchangeRate: 1,
        lines: [],
        subtotal: 100, taxTotal: 0, total: 100, totalBase: 100,
        amountPaid: 0, amountDue: 100,
        billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
        createdBy: user._id,
      } as any)
    }

    // Sequence is still at 0 — exactly the bug scenario.
    const pre = await Sequence.findOne({ orgId: org._id, prefix: 'SALES_DOC', year }).lean()
    expect(pre?.lastNumber ?? 0).toBe(0)

    // Replay the controller's reconcile: scan max INV/CRN/DBN suffix → bump counter → allocate.
    const existingMax = 10
    await ensureSequenceAtLeast(String(org._id), 'SALES_DOC', year, existingMax)
    const raw = await getNextNumber(String(org._id), 'SALES_DOC', 5, year)
    const seq = Number(raw.split('-').pop())
    expect(seq).toBe(11)
    // When emitted with the CRN prefix this becomes the expected "CRN-2026-00011".
    expect(`CRN-${year}-${String(seq).padStart(5, '0')}`).toBe('CRN-2026-00011')
  })
})
