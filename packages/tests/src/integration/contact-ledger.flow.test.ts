import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { getContactLedger } from 'services/biz/contact-ledger.service'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Contact Ledger', () => {
  it('should return empty ledger for contact with no invoices', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    const result = await getContactLedger(String(org._id), String(contact._id))

    expect(result.entries).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.summary.totalSales).toBe(0)
    expect(result.summary.totalPurchases).toBe(0)
    expect(result.summary.balance).toBe(0)
  })

  it('should show sales invoice entries with product details', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Widget' })
    const warehouse = await createTestWarehouse(org._id)

    await createTestInvoice(org._id, contact._id, {
      type: 'invoice',
      direction: 'outgoing',
      status: 'sent',
      lines: [{
        productId: product._id,
        description: 'Widget',
        quantity: 10,
        unit: 'pcs',
        unitPrice: 25,
        discount: 0,
        taxRate: 18,
        taxAmount: 45,
        lineTotal: 295,
        warehouseId: warehouse._id,
      }],
    })

    const result = await getContactLedger(String(org._id), String(contact._id))

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].documentType).toBe('invoice')
    expect(result.entries[0].productName).toBe('Widget')
    expect(result.entries[0].quantity).toBe(10)
    expect(result.entries[0].unitPrice).toBe(25)
    expect(result.entries[0].lineTotal).toBe(295)
    expect(result.entries[0].warehouseName).toBe(warehouse.name)
  })

  it('should compute summary totals for outgoing and incoming invoices', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    // Outgoing (sale)
    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent', total: 500,
    })

    // Incoming (purchase)
    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'incoming', status: 'sent', total: 200,
      invoiceNumber: `BILL-${Date.now()}`,
    })

    const result = await getContactLedger(String(org._id), String(contact._id))

    expect(result.summary.totalSales).toBe(500)
    expect(result.summary.totalPurchases).toBe(200)
    expect(result.summary.balance).toBe(300)
  })

  it('should filter by date range', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent',
      issueDate: new Date('2025-01-15'), total: 100,
      invoiceNumber: `INV-JAN-${Date.now()}`,
    })
    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent',
      issueDate: new Date('2025-06-15'), total: 200,
      invoiceNumber: `INV-JUN-${Date.now()}`,
    })

    const result = await getContactLedger(String(org._id), String(contact._id), {
      dateFrom: '2025-05-01',
      dateTo: '2025-12-31',
    })

    // Only the June invoice should match
    expect(result.summary.totalSales).toBe(200)
  })

  it('should filter by document type', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    await createTestInvoice(org._id, contact._id, {
      type: 'invoice', direction: 'outgoing', status: 'sent', total: 100,
    })
    await createTestInvoice(org._id, contact._id, {
      type: 'credit_note', direction: 'outgoing', status: 'sent', total: 50,
      invoiceNumber: `CRN-${Date.now()}`,
    })

    const result = await getContactLedger(String(org._id), String(contact._id), {
      documentTypes: ['credit_note'],
    })

    expect(result.entries.length).toBeGreaterThanOrEqual(0)
    expect(result.summary.totalSales).toBe(50) // only credit note
  })

  it('should paginate results', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)

    // Create 5 invoices
    for (let i = 0; i < 5; i++) {
      await createTestInvoice(org._id, contact._id, {
        type: 'invoice', direction: 'outgoing', status: 'sent', total: 100,
        invoiceNumber: `INV-PAG-${Date.now()}-${i}`,
      })
    }

    const page0 = await getContactLedger(String(org._id), String(contact._id), { page: 0, size: 2 })
    expect(page0.entries.length).toBeLessThanOrEqual(2)
    expect(page0.total).toBeGreaterThanOrEqual(5)
    expect(page0.totalPages).toBeGreaterThanOrEqual(3)
  })
})
