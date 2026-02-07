import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { invoiceDao } from 'services/dao/invoicing/invoice.dao'
import { contactDao } from 'services/dao/invoicing/contact.dao'
import { createTestOrg, createTestContact, createTestInvoice } from '../../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('InvoiceDao', () => {
  it('should find invoices by contact', async () => {
    const org = await createTestOrg({ slug: 'inv-by-contact' })
    const contact1 = await createTestContact(org._id)
    const contact2 = await createTestContact(org._id)

    await createTestInvoice(org._id, contact1._id, { invoiceNumber: 'INV-C1-001' })
    await createTestInvoice(org._id, contact1._id, { invoiceNumber: 'INV-C1-002' })
    await createTestInvoice(org._id, contact2._id, { invoiceNumber: 'INV-C2-001' })

    const results = await invoiceDao.findByContact(String(org._id), String(contact1._id))
    expect(results).toHaveLength(2)
    expect(results.every((inv) => String(inv.contactId) === String(contact1._id))).toBe(true)
  })

  it('should find invoices by status', async () => {
    const org = await createTestOrg({ slug: 'inv-by-status' })
    const contact = await createTestContact(org._id)

    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-S-001', status: 'draft' })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-S-002', status: 'sent' })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-S-003', status: 'sent' })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-S-004', status: 'paid' })

    const sent = await invoiceDao.findByStatus(String(org._id), 'sent')
    expect(sent).toHaveLength(2)
    expect(sent.every((inv) => inv.status === 'sent')).toBe(true)
  })

  it('should find invoices by direction', async () => {
    const org = await createTestOrg({ slug: 'inv-by-direction' })
    const contact = await createTestContact(org._id)

    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-D-001', direction: 'outgoing' })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-D-002', direction: 'outgoing' })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-D-003', direction: 'incoming' })

    const outgoing = await invoiceDao.findByDirection(String(org._id), 'outgoing')
    expect(outgoing).toHaveLength(2)
    expect(outgoing.every((inv) => inv.direction === 'outgoing')).toBe(true)

    const incoming = await invoiceDao.findByDirection(String(org._id), 'incoming')
    expect(incoming).toHaveLength(1)
    expect(incoming[0].direction).toBe('incoming')
  })

  it('should find overdue invoices excluding paid, voided, and cancelled', async () => {
    const org = await createTestOrg({ slug: 'inv-overdue' })
    const contact = await createTestContact(org._id)

    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    // Overdue and unpaid - should appear
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-OD-001',
      dueDate: pastDate,
      status: 'sent',
    })
    // Overdue but paid - should NOT appear
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-OD-002',
      dueDate: pastDate,
      status: 'paid',
    })
    // Overdue but voided - should NOT appear
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-OD-003',
      dueDate: pastDate,
      status: 'voided',
    })
    // Overdue but cancelled - should NOT appear
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-OD-004',
      dueDate: pastDate,
      status: 'cancelled',
    })
    // Not yet due - should NOT appear
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-OD-005',
      dueDate: futureDate,
      status: 'sent',
    })
    // Overdue draft - should appear
    await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-OD-006',
      dueDate: pastDate,
      status: 'draft',
    })

    const overdue = await invoiceDao.findOverdue(String(org._id))
    expect(overdue).toHaveLength(2)
    const numbers = overdue.map((inv) => inv.invoiceNumber).sort()
    expect(numbers).toEqual(['INV-OD-001', 'INV-OD-006'])
  })

  it('should find invoices by date range', async () => {
    const org = await createTestOrg({ slug: 'inv-date-range' })
    const contact = await createTestContact(org._id)

    const jan15 = new Date('2025-01-15')
    const feb15 = new Date('2025-02-15')
    const mar15 = new Date('2025-03-15')

    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-DR-001', issueDate: jan15 })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-DR-002', issueDate: feb15 })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: 'INV-DR-003', issueDate: mar15 })

    const results = await invoiceDao.findByDateRange(
      String(org._id),
      new Date('2025-01-01'),
      new Date('2025-02-28'),
    )
    expect(results).toHaveLength(2)
    const numbers = results.map((inv) => inv.invoiceNumber).sort()
    expect(numbers).toEqual(['INV-DR-001', 'INV-DR-002'])
  })

  it('should generate first invoice number as INV-YYYY-00001', async () => {
    const org = await createTestOrg({ slug: 'inv-num-first' })
    const year = new Date().getFullYear()

    const number = await invoiceDao.getNextInvoiceNumber(String(org._id), 'invoice')
    expect(number).toBe(`INV-${year}-00001`)
  })

  it('should generate first proforma number as PRF-YYYY-00001', async () => {
    const org = await createTestOrg({ slug: 'inv-num-proforma' })
    const year = new Date().getFullYear()

    const number = await invoiceDao.getNextInvoiceNumber(String(org._id), 'proforma')
    expect(number).toBe(`PRF-${year}-00001`)
  })

  it('should auto-increment invoice numbers correctly', async () => {
    const org = await createTestOrg({ slug: 'inv-num-inc' })
    const contact = await createTestContact(org._id)
    const year = new Date().getFullYear()

    // Seed two invoices with known invoice numbers for the current year
    await createTestInvoice(org._id, contact._id, { invoiceNumber: `INV-${year}-00001` })
    await createTestInvoice(org._id, contact._id, { invoiceNumber: `INV-${year}-00003` })

    const next = await invoiceDao.getNextInvoiceNumber(String(org._id), 'invoice')
    expect(next).toBe(`INV-${year}-00004`)
  })
})

describe('ContactDao', () => {
  it('should find contacts by type', async () => {
    const org = await createTestOrg({ slug: 'contact-by-type' })

    await createTestContact(org._id, { type: 'customer', email: 'cust1@test.com' })
    await createTestContact(org._id, { type: 'customer', email: 'cust2@test.com' })
    await createTestContact(org._id, { type: 'supplier', email: 'supp1@test.com' })

    const customers = await contactDao.findByType(String(org._id), 'customer')
    expect(customers).toHaveLength(2)
    expect(customers.every((c) => c.type === 'customer')).toBe(true)
  })

  it('should find contact by email', async () => {
    const org = await createTestOrg({ slug: 'contact-by-email' })
    await createTestContact(org._id, { email: 'unique@example.com', companyName: 'Unique Corp' })

    const found = await contactDao.findByEmail(String(org._id), 'unique@example.com')
    expect(found).toBeDefined()
    expect(found!.email).toBe('unique@example.com')
    expect(found!.companyName).toBe('Unique Corp')
  })

  it('should find contact by tax ID', async () => {
    const org = await createTestOrg({ slug: 'contact-by-taxid' })
    await createTestContact(org._id, { taxId: 'DE123456789', email: 'tax@test.com' })

    const found = await contactDao.findByTaxId(String(org._id), 'DE123456789')
    expect(found).toBeDefined()
    expect(found!.taxId).toBe('DE123456789')
  })

  it('should search contacts by name and email', async () => {
    const org = await createTestOrg({ slug: 'contact-search' })

    await createTestContact(org._id, {
      companyName: 'Acme Widgets',
      firstName: 'Alice',
      lastName: 'Wonder',
      email: 'alice@acme.com',
    })
    await createTestContact(org._id, {
      companyName: 'Beta Corp',
      firstName: 'Bob',
      lastName: 'Builder',
      email: 'bob@beta.com',
    })
    await createTestContact(org._id, {
      companyName: 'Gamma LLC',
      firstName: 'Alice',
      lastName: 'Gamma',
      email: 'alice@gamma.com',
    })

    // Search by company name
    const byCompany = await contactDao.search(String(org._id), 'Acme')
    expect(byCompany).toHaveLength(1)
    expect(byCompany[0].companyName).toBe('Acme Widgets')

    // Search by first name - should match both Alices
    const byFirstName = await contactDao.search(String(org._id), 'Alice')
    expect(byFirstName).toHaveLength(2)

    // Search by email fragment
    const byEmail = await contactDao.search(String(org._id), 'bob@beta')
    expect(byEmail).toHaveLength(1)
    expect(byEmail[0].firstName).toBe('Bob')
  })

  it('should return null for non-existent email', async () => {
    const org = await createTestOrg({ slug: 'contact-no-email' })

    const found = await contactDao.findByEmail(String(org._id), 'nobody@nowhere.com')
    expect(found).toBeNull()
  })
})

describe('Multi-tenancy isolation', () => {
  it('should not expose invoices across orgs', async () => {
    const org1 = await createTestOrg({ slug: 'tenant-iso-org1' })
    const org2 = await createTestOrg({ slug: 'tenant-iso-org2' })

    const contact1 = await createTestContact(org1._id, { email: 'c1@org1.com' })
    const contact2 = await createTestContact(org2._id, { email: 'c2@org2.com' })

    await createTestInvoice(org1._id, contact1._id, { invoiceNumber: 'INV-ISO-001', status: 'sent' })
    await createTestInvoice(org1._id, contact1._id, { invoiceNumber: 'INV-ISO-002', status: 'sent' })
    await createTestInvoice(org2._id, contact2._id, { invoiceNumber: 'INV-ISO-003', status: 'sent' })

    const org1Invoices = await invoiceDao.findByStatus(String(org1._id), 'sent')
    const org2Invoices = await invoiceDao.findByStatus(String(org2._id), 'sent')

    expect(org1Invoices).toHaveLength(2)
    expect(org2Invoices).toHaveLength(1)

    // Org2 should not see org1's invoices via contact query
    const crossCheck = await invoiceDao.findByContact(String(org2._id), String(contact1._id))
    expect(crossCheck).toHaveLength(0)
  })
})
