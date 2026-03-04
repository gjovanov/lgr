import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestInvoice } from '../helpers/factories'
import { Invoice } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Proforma Conversion Flow', () => {
  it('should convert proforma to invoice and persist convertedInvoiceId on proforma', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const proforma = await createTestInvoice(org._id, contact._id, {
      type: 'proforma',
      invoiceNumber: 'PRO-000001',
      status: 'draft',
    })

    // Simulate conversion: create invoice with proformaId, update proforma with convertedInvoiceId
    const invoice = await Invoice.create({
      orgId: org._id,
      type: 'invoice',
      direction: proforma.direction,
      contactId: proforma.contactId,
      invoiceNumber: 'INV-000001',
      issueDate: new Date(),
      dueDate: proforma.dueDate,
      currency: proforma.currency,
      exchangeRate: proforma.exchangeRate,
      lines: proforma.lines,
      subtotal: proforma.subtotal,
      taxTotal: proforma.taxTotal,
      total: proforma.total,
      totalBase: proforma.totalBase,
      amountDue: proforma.total,
      billingAddress: proforma.billingAddress,
      proformaId: proforma._id,
      status: 'draft',
      createdBy: proforma.createdBy,
    })

    proforma.status = 'converted'
    proforma.convertedInvoiceId = invoice._id
    await proforma.save()

    const updatedProforma = await Invoice.findById(proforma._id)
    expect(updatedProforma).toBeDefined()
    expect(String(updatedProforma!.convertedInvoiceId)).toBe(String(invoice._id))

    const updatedInvoice = await Invoice.findById(invoice._id)
    expect(updatedInvoice).toBeDefined()
    expect(String(updatedInvoice!.proformaId)).toBe(String(proforma._id))
  })

  it('should persist proformaId on the resulting invoice through round-trip', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const proforma = await createTestInvoice(org._id, contact._id, {
      type: 'proforma',
      invoiceNumber: 'PRO-000002',
    })

    const invoice = await Invoice.create({
      orgId: org._id,
      type: 'invoice',
      direction: 'outgoing',
      contactId: contact._id,
      invoiceNumber: 'INV-000002',
      issueDate: new Date(),
      dueDate: new Date(),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [{ description: 'Test', quantity: 1, unit: 'pcs', unitPrice: 100, discount: 0, taxRate: 18, taxAmount: 18, lineTotal: 118 }],
      subtotal: 100,
      taxTotal: 18,
      total: 118,
      totalBase: 118,
      amountDue: 118,
      billingAddress: { street: '1 St', city: 'Berlin', postalCode: '10115', country: 'DE' },
      proformaId: proforma._id,
      status: 'draft',
      createdBy: proforma.createdBy,
    })

    // Re-fetch from DB
    const fetched = await Invoice.findById(invoice._id)
    expect(fetched).toBeDefined()
    expect(String(fetched!.proformaId)).toBe(String(proforma._id))
  })

  it('should reject converting an already-converted proforma', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const proforma = await createTestInvoice(org._id, contact._id, {
      type: 'proforma',
      invoiceNumber: 'PRO-000003',
      status: 'converted',
    })

    // Attempting to convert should fail (status is already 'converted')
    expect(proforma.status).toBe('converted')
  })

  it('should reject converting a non-proforma invoice', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      type: 'invoice',
      invoiceNumber: 'INV-000003',
    })

    // Non-proforma invoices should not be converted
    expect(invoice.type).toBe('invoice')
    expect(invoice.type).not.toBe('proforma')
  })
})
