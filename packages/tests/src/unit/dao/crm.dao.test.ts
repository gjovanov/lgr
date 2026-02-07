import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { leadDao } from 'services/dao/crm/lead.dao'
import { dealDao } from 'services/dao/crm/deal.dao'
import { pipelineDao } from 'services/dao/crm/pipeline.dao'
import { activityDao } from 'services/dao/crm/activity.dao'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestLead,
  createTestDeal,
  createTestPipeline,
  createTestActivity,
} from '../../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('LeadDao', () => {
  it('should find leads by status', async () => {
    const org = await createTestOrg({ slug: 'lead-status-org' })
    await createTestLead(org._id, { status: 'new' })
    await createTestLead(org._id, { status: 'new' })
    await createTestLead(org._id, { status: 'qualified' })

    const newLeads = await leadDao.findByStatus(String(org._id), 'new')
    expect(newLeads).toHaveLength(2)
    expect(newLeads.every((l) => l.status === 'new')).toBe(true)

    const qualifiedLeads = await leadDao.findByStatus(String(org._id), 'qualified')
    expect(qualifiedLeads).toHaveLength(1)
    expect(qualifiedLeads[0].status).toBe('qualified')
  })

  it('should find leads by assignee', async () => {
    const org = await createTestOrg({ slug: 'lead-assignee-org' })
    const user = await createTestUser(org._id, { username: 'lead-owner' })

    await createTestLead(org._id, { assignedTo: user._id })
    await createTestLead(org._id, { assignedTo: user._id })
    await createTestLead(org._id) // different assignedTo (random objectId from factory)

    const leads = await leadDao.findByAssignee(String(org._id), String(user._id))
    expect(leads).toHaveLength(2)
    expect(leads.every((l) => String(l.assignedTo) === String(user._id))).toBe(true)
  })

  it('should find leads by source', async () => {
    const org = await createTestOrg({ slug: 'lead-source-org' })
    await createTestLead(org._id, { source: 'referral' })
    await createTestLead(org._id, { source: 'referral' })
    await createTestLead(org._id, { source: 'website' })

    const referralLeads = await leadDao.findBySource(String(org._id), 'referral')
    expect(referralLeads).toHaveLength(2)
    expect(referralLeads.every((l) => l.source === 'referral')).toBe(true)

    const websiteLeads = await leadDao.findBySource(String(org._id), 'website')
    expect(websiteLeads).toHaveLength(1)
  })
})

describe('DealDao', () => {
  it('should find deals by pipeline', async () => {
    const org = await createTestOrg({ slug: 'deal-pipeline-org' })
    const contact = await createTestContact(org._id)
    const pipeline1 = await createTestPipeline(org._id, { name: 'Sales' })
    const pipeline2 = await createTestPipeline(org._id, { name: 'Enterprise', isDefault: false })

    await createTestDeal(org._id, contact._id, pipeline1._id)
    await createTestDeal(org._id, contact._id, pipeline1._id)
    await createTestDeal(org._id, contact._id, pipeline2._id)

    const deals = await dealDao.findByPipeline(String(org._id), String(pipeline1._id))
    expect(deals).toHaveLength(2)
    expect(deals.every((d) => String(d.pipelineId) === String(pipeline1._id))).toBe(true)
  })

  it('should find deals by stage within a pipeline', async () => {
    const org = await createTestOrg({ slug: 'deal-stage-org' })
    const contact = await createTestContact(org._id)
    const pipeline = await createTestPipeline(org._id)

    await createTestDeal(org._id, contact._id, pipeline._id, { stage: 'Prospecting' })
    await createTestDeal(org._id, contact._id, pipeline._id, { stage: 'Prospecting' })
    await createTestDeal(org._id, contact._id, pipeline._id, { stage: 'Negotiation' })

    const prospecting = await dealDao.findByStage(String(org._id), String(pipeline._id), 'Prospecting')
    expect(prospecting).toHaveLength(2)
    expect(prospecting.every((d) => d.stage === 'Prospecting')).toBe(true)

    const negotiation = await dealDao.findByStage(String(org._id), String(pipeline._id), 'Negotiation')
    expect(negotiation).toHaveLength(1)
    expect(negotiation[0].stage).toBe('Negotiation')
  })

  it('should find deals by assignee', async () => {
    const org = await createTestOrg({ slug: 'deal-assignee-org' })
    const contact = await createTestContact(org._id)
    const pipeline = await createTestPipeline(org._id)
    const user = await createTestUser(org._id, { username: 'deal-owner' })

    await createTestDeal(org._id, contact._id, pipeline._id, { assignedTo: user._id })
    await createTestDeal(org._id, contact._id, pipeline._id, { assignedTo: user._id })
    await createTestDeal(org._id, contact._id, pipeline._id) // random assignedTo

    const deals = await dealDao.findByAssignee(String(org._id), String(user._id))
    expect(deals).toHaveLength(2)
    expect(deals.every((d) => String(d.assignedTo) === String(user._id))).toBe(true)
  })
})

describe('PipelineDao', () => {
  it('should find the default pipeline', async () => {
    const org = await createTestOrg({ slug: 'pipeline-default-org' })
    await createTestPipeline(org._id, { isDefault: true, name: 'Default Pipeline' })
    await createTestPipeline(org._id, { isDefault: false, name: 'Secondary Pipeline' })

    const defaultPipeline = await pipelineDao.findDefault(String(org._id))
    expect(defaultPipeline).toBeDefined()
    expect(defaultPipeline!.name).toBe('Default Pipeline')
    expect(defaultPipeline!.isDefault).toBe(true)
  })

  it('should find active pipelines', async () => {
    const org = await createTestOrg({ slug: 'pipeline-active-org' })
    await createTestPipeline(org._id, { isActive: true, name: 'Active 1' })
    await createTestPipeline(org._id, { isActive: true, name: 'Active 2' })
    await createTestPipeline(org._id, { isActive: false, name: 'Inactive' })

    const active = await pipelineDao.findActive(String(org._id))
    expect(active).toHaveLength(2)
    expect(active.every((p) => p.isActive === true)).toBe(true)
  })
})

describe('ActivityDao', () => {
  it('should find activities by assignee', async () => {
    const org = await createTestOrg({ slug: 'activity-assignee-org' })
    const user1 = await createTestUser(org._id, { username: 'activity-user1', email: 'au1@test.com' })
    const user2 = await createTestUser(org._id, { username: 'activity-user2', email: 'au2@test.com' })

    await createTestActivity(org._id, user1._id, { subject: 'Call client' })
    await createTestActivity(org._id, user1._id, { subject: 'Send proposal' })
    await createTestActivity(org._id, user2._id, { subject: 'Schedule demo' })

    const user1Activities = await activityDao.findByAssignee(String(org._id), String(user1._id))
    expect(user1Activities).toHaveLength(2)
    expect(user1Activities.every((a) => String(a.assignedTo) === String(user1._id))).toBe(true)

    const user2Activities = await activityDao.findByAssignee(String(org._id), String(user2._id))
    expect(user2Activities).toHaveLength(1)
  })

  it('should find pending activities', async () => {
    const org = await createTestOrg({ slug: 'activity-pending-org' })
    const user = await createTestUser(org._id, { username: 'activity-pending-user' })

    await createTestActivity(org._id, user._id, { status: 'pending' })
    await createTestActivity(org._id, user._id, { status: 'pending' })
    await createTestActivity(org._id, user._id, { status: 'completed' })

    const pending = await activityDao.findPending(String(org._id))
    expect(pending).toHaveLength(2)
    expect(pending.every((a) => a.status === 'pending')).toBe(true)
  })
})
