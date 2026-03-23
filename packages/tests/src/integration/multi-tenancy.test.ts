import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse, createTestStockLevel, createTestEmployee } from '../helpers/factories'
import { Invoice, Contact, Product, Employee } from 'db/models'
import { getStockValuation } from 'services/biz/warehouse.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Multi-Tenancy Isolation', () => {
  it('should isolate contacts between organizations', async () => {
    const orgA = await createTestOrg({ name: 'Org A', slug: 'org-a' })
    const orgB = await createTestOrg({ name: 'Org B', slug: 'org-b' })

    await createTestContact(orgA._id, { companyName: 'Alpha Client' })
    await createTestContact(orgA._id, { companyName: 'Beta Client' })
    await createTestContact(orgB._id, { companyName: 'Gamma Client' })

    const contactsA = await Contact.find({ orgId: orgA._id })
    const contactsB = await Contact.find({ orgId: orgB._id })

    expect(contactsA).toHaveLength(2)
    expect(contactsB).toHaveLength(1)
    expect(contactsA.every(c => String(c.orgId) === String(orgA._id))).toBe(true)
    expect(contactsB[0].companyName).toBe('Gamma Client')
  })

  it('should isolate invoices between organizations', async () => {
    const orgA = await createTestOrg({ name: 'Org A', slug: 'org-a-inv' })
    const orgB = await createTestOrg({ name: 'Org B', slug: 'org-b-inv' })

    const contactA = await createTestContact(orgA._id)
    const contactB = await createTestContact(orgB._id)

    await createTestInvoice(orgA._id, contactA._id, { total: 1000, amountDue: 1000 })
    await createTestInvoice(orgA._id, contactA._id, { total: 2000, amountDue: 2000 })
    await createTestInvoice(orgB._id, contactB._id, { total: 5000, amountDue: 5000 })

    const invoicesA = await Invoice.find({ orgId: orgA._id })
    const invoicesB = await Invoice.find({ orgId: orgB._id })

    expect(invoicesA).toHaveLength(2)
    expect(invoicesB).toHaveLength(1)
    expect(invoicesB[0].total).toBe(5000)
  })

  it('should isolate employees between organizations', async () => {
    const orgA = await createTestOrg({ name: 'Org A', slug: 'org-a-emp' })
    const orgB = await createTestOrg({ name: 'Org B', slug: 'org-b-emp' })

    await createTestEmployee(orgA._id, { firstName: 'Alice' })
    await createTestEmployee(orgA._id, { firstName: 'Bob' })
    await createTestEmployee(orgA._id, { firstName: 'Charlie' })
    await createTestEmployee(orgB._id, { firstName: 'Dave' })

    const empsA = await Employee.find({ orgId: orgA._id })
    const empsB = await Employee.find({ orgId: orgB._id })

    expect(empsA).toHaveLength(3)
    expect(empsB).toHaveLength(1)
    expect(empsB[0].firstName).toBe('Dave')
  })

  it('should isolate stock valuation between organizations', async () => {
    const orgA = await createTestOrg({ name: 'Org A', slug: 'org-a-stock' })
    const orgB = await createTestOrg({ name: 'Org B', slug: 'org-b-stock' })

    const productA = await createTestProduct(orgA._id, { name: 'Product A' })
    const whA = await createTestWarehouse(orgA._id)
    await createTestStockLevel(orgA._id, productA._id, whA._id, { quantity: 500, availableQuantity: 500, avgCost: 10 })

    const productB = await createTestProduct(orgB._id, { name: 'Product B' })
    const whB = await createTestWarehouse(orgB._id)
    await createTestStockLevel(orgB._id, productB._id, whB._id, { quantity: 200, availableQuantity: 200, avgCost: 20 })

    const valA = await getStockValuation(String(orgA._id))
    const valB = await getStockValuation(String(orgB._id))

    expect(valA.items).toHaveLength(1)
    expect(valA.totalValue).toBe(5000) // 500 * 10
    expect(valB.items).toHaveLength(1)
    expect(valB.totalValue).toBe(4000) // 200 * 20
  })

})
