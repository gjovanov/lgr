import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestLead, createTestPipeline, createTestDeal } from '../helpers/factories'
import { Contact, Deal, Lead } from 'db/models'
import { convertLead, moveDealStage, getPipelineSummary } from 'services/biz/crm.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('CRM Flow', () => {
  it('should convert a lead into a contact', async () => {
    const org = await createTestOrg()
    const lead = await createTestLead(org._id, { companyName: 'Acme Corp', contactName: 'John Doe' })

    const result = await convertLead(String(lead._id), { createDeal: false })

    expect(result.contact).toBeDefined()
    expect(result.contact.companyName).toBe('Acme Corp')
    expect(result.contact.firstName).toBe('John')
    expect(result.contact.lastName).toBe('Doe')
    expect(result.deal).toBeUndefined()

    const updatedLead = await Lead.findById(lead._id)
    expect(updatedLead!.status).toBe('converted')
    expect(updatedLead!.convertedToContactId).toBeDefined()
    expect(updatedLead!.convertedAt).toBeDefined()
  })

  it('should convert a lead into a contact and deal', async () => {
    const org = await createTestOrg()
    const pipeline = await createTestPipeline(org._id)
    const lead = await createTestLead(org._id, {
      companyName: 'Big Corp',
      contactName: 'Jane Smith',
      estimatedValue: 50000,
    })

    const result = await convertLead(String(lead._id), {
      createDeal: true,
      pipelineId: String(pipeline._id),
    })

    expect(result.contact).toBeDefined()
    expect(result.deal).toBeDefined()
    expect(result.deal!.value).toBe(50000)
    expect(result.deal!.stage).toBe('Prospecting') // first pipeline stage
    expect(result.deal!.probability).toBe(10) // first stage probability
    expect(String(result.deal!.contactId)).toBe(String(result.contact._id))
    expect(String(result.deal!.pipelineId)).toBe(String(pipeline._id))
  })

  it('should reject converting an already converted lead', async () => {
    const org = await createTestOrg()
    const lead = await createTestLead(org._id)

    await convertLead(String(lead._id), { createDeal: false })

    await expect(
      convertLead(String(lead._id), { createDeal: false }),
    ).rejects.toThrow('Lead already converted')
  })

  it('should move a deal through pipeline stages', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const pipeline = await createTestPipeline(org._id)
    const deal = await createTestDeal(org._id, contact._id, pipeline._id, { stage: 'Prospecting', probability: 10 })

    const qualified = await moveDealStage(String(deal._id), 'Qualification')
    expect(qualified.stage).toBe('Qualification')
    expect(qualified.probability).toBe(25)

    const proposal = await moveDealStage(String(deal._id), 'Proposal')
    expect(proposal.stage).toBe('Proposal')
    expect(proposal.probability).toBe(50)

    const won = await moveDealStage(String(deal._id), 'Closed Won')
    expect(won.stage).toBe('Closed Won')
    expect(won.probability).toBe(100)
  })

  it('should reject moving deal to invalid stage', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const pipeline = await createTestPipeline(org._id)
    const deal = await createTestDeal(org._id, contact._id, pipeline._id)

    await expect(
      moveDealStage(String(deal._id), 'Non Existent Stage'),
    ).rejects.toThrow('Stage "Non Existent Stage" not found in pipeline')
  })

  it('should generate pipeline summary with weighted values', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const pipeline = await createTestPipeline(org._id)

    await createTestDeal(org._id, contact._id, pipeline._id, { stage: 'Prospecting', value: 10000, probability: 10 })
    await createTestDeal(org._id, contact._id, pipeline._id, { stage: 'Prospecting', value: 20000, probability: 10 })
    await createTestDeal(org._id, contact._id, pipeline._id, { stage: 'Proposal', value: 50000, probability: 50 })

    const summary = await getPipelineSummary(String(org._id), String(pipeline._id))

    expect(summary.totalDeals).toBe(3)
    expect(summary.totalValue).toBe(80000)
    expect(summary.stages).toHaveLength(5)

    const prospecting = summary.stages.find(s => s.name === 'Prospecting')
    expect(prospecting!.dealCount).toBe(2)
    expect(prospecting!.totalValue).toBe(30000)
    expect(prospecting!.weightedValue).toBe(3000) // 30000 * 10%

    const proposal = summary.stages.find(s => s.name === 'Proposal')
    expect(proposal!.dealCount).toBe(1)
    expect(proposal!.totalValue).toBe(50000)
    expect(proposal!.weightedValue).toBe(25000) // 50000 * 50%

    expect(summary.totalWeightedValue).toBe(28000) // 3000 + 25000
  })
})
