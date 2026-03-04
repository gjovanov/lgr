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

describe('Credit Note Flow', () => {
  it('should persist relatedInvoiceId on credit note', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-CN-001',
    })

    const creditNote = await createTestInvoice(org._id, contact._id, {
      type: 'credit_note',
      invoiceNumber: 'CN-000001',
      relatedInvoiceId: invoice._id,
    })

    const fetched = await Invoice.findById(creditNote._id)
    expect(fetched).toBeDefined()
    expect(String(fetched!.relatedInvoiceId)).toBe(String(invoice._id))
  })

  it('should populate relatedInvoiceId with invoiceNumber in list query', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-CN-002',
    })

    await createTestInvoice(org._id, contact._id, {
      type: 'credit_note',
      invoiceNumber: 'CN-000002',
      relatedInvoiceId: invoice._id,
    })

    // Query credit notes and populate relatedInvoiceId
    const creditNotes = await Invoice.find({ orgId: org._id, type: 'credit_note' }).lean().exec()
    const populated = await Invoice.populate(creditNotes, [
      { path: 'relatedInvoiceId', select: 'invoiceNumber' },
    ])

    expect(populated).toHaveLength(1)
    const cn = populated[0] as any
    expect(cn.relatedInvoiceId).toBeDefined()
    expect(cn.relatedInvoiceId.invoiceNumber).toBe('INV-CN-002')
  })
})
