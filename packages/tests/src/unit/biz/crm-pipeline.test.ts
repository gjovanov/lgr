import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import {
  createTestOrg,
  createTestLead,
  createTestPipeline,
  createTestContact,
  createTestDeal,
} from '../../helpers/factories'
import { convertLead, moveDealStage, getPipelineSummary } from 'services/biz/crm.service'
import { Lead, Contact, Deal } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('convertLead', () => {
  it('should create a Contact from lead data', async () => {
    const org = await createTestOrg({ slug: 'convert-lead-org' })
    await createTestPipeline(org._id)
    const lead = await createTestLead(org._id, {
      companyName: 'Acme Corp',
      contactName: 'John Doe',
      email: 'john@acme.com',
      phone: '+49123456789',
      website: 'https://acme.com',
    })

    const result = await convertLead(String(lead._id), { createDeal: false })

    expect(result.contact).toBeDefined()
    expect(result.contact.companyName).toBe('Acme Corp')
    expect(result.contact.firstName).toBe('John')
    expect(result.contact.lastName).toBe('Doe')
    expect(result.contact.email).toBe('john@acme.com')
    expect(result.contact.phone).toBe('+49123456789')
    expect(result.contact.website).toBe('https://acme.com')
    expect(result.contact.type).toBe('customer')
    expect(result.contact.isActive).toBe(true)
    expect(result.contact.paymentTermsDays).toBe(30)
  })

  it('should mark lead as converted with convertedToContactId', async () => {
    const org = await createTestOrg({ slug: 'mark-converted-org' })
    const lead = await createTestLead(org._id, {
      companyName: 'Beta Inc',
      contactName: 'Jane Smith',
    })

    const result = await convertLead(String(lead._id), { createDeal: false })

    const updatedLead = await Lead.findById(lead._id)
    expect(updatedLead!.status).toBe('converted')
    expect(String(updatedLead!.convertedToContactId)).toBe(String(result.contact._id))
    expect(updatedLead!.convertedAt).toBeDefined()
  })

  it('should create a Deal when options.createDeal is true', async () => {
    const org = await createTestOrg({ slug: 'create-deal-org' })
    const pipeline = await createTestPipeline(org._id)
    const lead = await createTestLead(org._id, {
      companyName: 'Gamma LLC',
      contactName: 'Bob Builder',
      estimatedValue: 50000,
      currency: 'EUR',
    })

    const result = await convertLead(String(lead._id), { createDeal: true })

    expect(result.deal).toBeDefined()
    expect(result.deal!.name).toBe('Gamma LLC - New Deal')
    expect(String(result.deal!.contactId)).toBe(String(result.contact._id))
    expect(result.deal!.value).toBe(50000)
    expect(result.deal!.currency).toBe('EUR')
    expect(result.deal!.status).toBe('open')
    expect(String(result.deal!.pipelineId)).toBe(String(pipeline._id))
  })

  it('should use default pipeline and first stage for auto-created deal', async () => {
    const org = await createTestOrg({ slug: 'default-pipeline-org' })
    const pipeline = await createTestPipeline(org._id, { isDefault: true })
    const lead = await createTestLead(org._id, {
      companyName: 'Delta Co',
      contactName: 'Alice Wonder',
    })

    const result = await convertLead(String(lead._id), { createDeal: true })

    expect(result.deal).toBeDefined()
    expect(result.deal!.stage).toBe(pipeline.stages[0].name)
    expect(result.deal!.probability).toBe(pipeline.stages[0].probability)
    expect(String(result.deal!.pipelineId)).toBe(String(pipeline._id))
  })

  it('should set lead.convertedToDealId when deal is created', async () => {
    const org = await createTestOrg({ slug: 'deal-id-on-lead-org' })
    await createTestPipeline(org._id)
    const lead = await createTestLead(org._id, {
      companyName: 'Epsilon Ltd',
      contactName: 'Eve Adams',
    })

    const result = await convertLead(String(lead._id), { createDeal: true })

    const updatedLead = await Lead.findById(lead._id)
    expect(updatedLead!.convertedToDealId).toBeDefined()
    expect(String(updatedLead!.convertedToDealId)).toBe(String(result.deal!._id))
  })

  it('should reject converting an already-converted lead', async () => {
    const org = await createTestOrg({ slug: 'double-convert-org' })
    await createTestPipeline(org._id)
    const lead = await createTestLead(org._id, {
      companyName: 'Zeta GmbH',
      contactName: 'Charlie Brown',
    })

    await convertLead(String(lead._id), { createDeal: false })
    await expect(convertLead(String(lead._id), { createDeal: false })).rejects.toThrow(
      'Lead already converted',
    )
  })

  it('should use dealValue override when provided', async () => {
    const org = await createTestOrg({ slug: 'deal-value-override-org' })
    await createTestPipeline(org._id)
    const lead = await createTestLead(org._id, {
      companyName: 'Theta Inc',
      contactName: 'Dave Clark',
      estimatedValue: 10000,
    })

    const result = await convertLead(String(lead._id), {
      createDeal: true,
      dealValue: 75000,
    })

    expect(result.deal).toBeDefined()
    expect(result.deal!.value).toBe(75000)
  })

  it('should throw when lead does not exist', async () => {
    const fakeId = '000000000000000000000000'
    await expect(convertLead(fakeId, { createDeal: false })).rejects.toThrow('Lead not found')
  })
})

describe('moveDealStage', () => {
  it('should update deal stage name', async () => {
    const org = await createTestOrg({ slug: 'move-stage-org' })
    const pipeline = await createTestPipeline(org._id)
    const contact = await createTestContact(org._id)
    const deal = await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
      probability: 10,
    })

    const updated = await moveDealStage(String(deal._id), 'Proposal')

    expect(updated.stage).toBe('Proposal')
  })

  it('should update deal probability to match stage probability', async () => {
    const org = await createTestOrg({ slug: 'stage-prob-org' })
    const pipeline = await createTestPipeline(org._id)
    const contact = await createTestContact(org._id)
    const deal = await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
      probability: 10,
    })

    const updated = await moveDealStage(String(deal._id), 'Negotiation')

    expect(updated.probability).toBe(75)

    const persisted = await Deal.findById(deal._id)
    expect(persisted!.stage).toBe('Negotiation')
    expect(persisted!.probability).toBe(75)
  })

  it('should reject moving to a non-existent stage in the pipeline', async () => {
    const org = await createTestOrg({ slug: 'invalid-stage-org' })
    const pipeline = await createTestPipeline(org._id)
    const contact = await createTestContact(org._id)
    const deal = await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
    })

    await expect(moveDealStage(String(deal._id), 'NonExistentStage')).rejects.toThrow(
      'Stage "NonExistentStage" not found in pipeline',
    )
  })
})

describe('getPipelineSummary', () => {
  it('should return stages with dealCount, totalValue, and weightedValue', async () => {
    const org = await createTestOrg({ slug: 'summary-org' })
    const pipeline = await createTestPipeline(org._id)
    const contact = await createTestContact(org._id)

    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
      value: 10000,
      probability: 10,
      status: 'open',
    })
    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
      value: 20000,
      probability: 10,
      status: 'open',
    })
    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Proposal',
      value: 50000,
      probability: 50,
      status: 'open',
    })

    const summary = await getPipelineSummary(String(org._id), String(pipeline._id))

    const prospecting = summary.stages.find(s => s.name === 'Prospecting')!
    expect(prospecting.dealCount).toBe(2)
    expect(prospecting.totalValue).toBe(30000)

    const proposal = summary.stages.find(s => s.name === 'Proposal')!
    expect(proposal.dealCount).toBe(1)
    expect(proposal.totalValue).toBe(50000)

    expect(summary.totalDeals).toBe(3)
    expect(summary.totalValue).toBe(80000)
  })

  it('should only count open status deals', async () => {
    const org = await createTestOrg({ slug: 'open-only-org' })
    const pipeline = await createTestPipeline(org._id)
    const contact = await createTestContact(org._id)

    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
      value: 10000,
      probability: 10,
      status: 'open',
    })
    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
      value: 20000,
      probability: 10,
      status: 'won',
    })

    const summary = await getPipelineSummary(String(org._id), String(pipeline._id))

    expect(summary.totalDeals).toBe(1)
    const prospecting = summary.stages.find(s => s.name === 'Prospecting')!
    expect(prospecting.dealCount).toBe(1)
    expect(prospecting.totalValue).toBe(10000)
  })

  it('should exclude closed/won/lost deals from summary', async () => {
    const org = await createTestOrg({ slug: 'exclude-closed-org' })
    const pipeline = await createTestPipeline(org._id)
    const contact = await createTestContact(org._id)

    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Closed Won',
      value: 100000,
      probability: 100,
      status: 'won',
    })
    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Prospecting',
      value: 50000,
      probability: 10,
      status: 'lost',
    })

    const summary = await getPipelineSummary(String(org._id), String(pipeline._id))

    expect(summary.totalDeals).toBe(0)
    expect(summary.totalValue).toBe(0)
    for (const stage of summary.stages) {
      expect(stage.dealCount).toBe(0)
      expect(stage.totalValue).toBe(0)
    }
  })

  it('should correctly calculate weightedValue as value * probability / 100', async () => {
    const org = await createTestOrg({ slug: 'weighted-value-org' })
    const pipeline = await createTestPipeline(org._id)
    const contact = await createTestContact(org._id)

    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Qualification',
      value: 40000,
      probability: 25,
      status: 'open',
    })
    await createTestDeal(org._id, contact._id, pipeline._id, {
      stage: 'Negotiation',
      value: 80000,
      probability: 75,
      status: 'open',
    })

    const summary = await getPipelineSummary(String(org._id), String(pipeline._id))

    const qualification = summary.stages.find(s => s.name === 'Qualification')!
    expect(qualification.weightedValue).toBe(40000 * 25 / 100) // 10000

    const negotiation = summary.stages.find(s => s.name === 'Negotiation')!
    expect(negotiation.weightedValue).toBe(80000 * 75 / 100) // 60000

    expect(summary.totalWeightedValue).toBe(10000 + 60000) // 70000
  })

  it('should handle pipeline with no deals (zero counts)', async () => {
    const org = await createTestOrg({ slug: 'empty-pipeline-org' })
    const pipeline = await createTestPipeline(org._id)

    const summary = await getPipelineSummary(String(org._id), String(pipeline._id))

    expect(summary.totalDeals).toBe(0)
    expect(summary.totalValue).toBe(0)
    expect(summary.totalWeightedValue).toBe(0)
    expect(summary.stages.length).toBe(pipeline.stages.length)
    for (const stage of summary.stages) {
      expect(stage.dealCount).toBe(0)
      expect(stage.totalValue).toBe(0)
      expect(stage.weightedValue).toBe(0)
    }
  })

  it('should return correct pipeline metadata', async () => {
    const org = await createTestOrg({ slug: 'pipeline-meta-org' })
    const pipeline = await createTestPipeline(org._id, { name: 'Enterprise Sales' })

    const summary = await getPipelineSummary(String(org._id), String(pipeline._id))

    expect(summary.pipeline.name).toBe('Enterprise Sales')
    expect(String(summary.pipeline.id)).toBe(String(pipeline._id))
    expect(summary.stages.length).toBe(5)
  })
})
