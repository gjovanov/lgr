import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse, createTestStockLevel, createTestLead, createTestEmployee, createTestPipeline, createTestDeal } from '../helpers/factories'
import { Invoice, Contact, Product, Lead, Employee, Deal } from 'db/models'
import { getStockValuation } from 'services/biz/warehouse.service'
import { getPipelineSummary } from 'services/biz/crm.service'

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

  it('should isolate CRM pipeline data between organizations', async () => {
    const orgA = await createTestOrg({ name: 'Org A', slug: 'org-a-crm' })
    const orgB = await createTestOrg({ name: 'Org B', slug: 'org-b-crm' })

    const contactA = await createTestContact(orgA._id)
    const pipelineA = await createTestPipeline(orgA._id)
    await createTestDeal(orgA._id, contactA._id, pipelineA._id, { value: 10000 })
    await createTestDeal(orgA._id, contactA._id, pipelineA._id, { value: 20000 })

    const contactB = await createTestContact(orgB._id)
    const pipelineB = await createTestPipeline(orgB._id)
    await createTestDeal(orgB._id, contactB._id, pipelineB._id, { value: 50000 })

    const summaryA = await getPipelineSummary(String(orgA._id), String(pipelineA._id))
    const summaryB = await getPipelineSummary(String(orgB._id), String(pipelineB._id))

    expect(summaryA.totalDeals).toBe(2)
    expect(summaryA.totalValue).toBe(30000)
    expect(summaryB.totalDeals).toBe(1)
    expect(summaryB.totalValue).toBe(50000)
  })

  it('should not leak leads across organizations', async () => {
    const orgA = await createTestOrg({ name: 'Org A', slug: 'org-a-leads' })
    const orgB = await createTestOrg({ name: 'Org B', slug: 'org-b-leads' })

    await createTestLead(orgA._id, { companyName: 'Lead A1' })
    await createTestLead(orgA._id, { companyName: 'Lead A2' })
    await createTestLead(orgB._id, { companyName: 'Lead B1' })

    const leadsA = await Lead.find({ orgId: orgA._id })
    const leadsB = await Lead.find({ orgId: orgB._id })
    const allLeads = await Lead.find({})

    expect(leadsA).toHaveLength(2)
    expect(leadsB).toHaveLength(1)
    expect(allLeads).toHaveLength(3)
    expect(leadsA.some(l => l.companyName === 'Lead B1')).toBe(false)
  })
})
