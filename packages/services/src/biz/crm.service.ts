import type { RepositoryRegistry } from 'dal'
import type { IDeal } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

export async function convertLead(
  leadId: string,
  options: { createDeal?: boolean; pipelineId?: string; dealValue?: number },
  repos?: RepositoryRegistry,
): Promise<{ contact: any; deal?: any }> {
  const r = repos ?? getRepos()

  const lead = await r.leads.findById(leadId)
  if (!lead) throw new Error('Lead not found')
  if (lead.status === 'converted') throw new Error('Lead already converted')

  const orgId = String(lead.orgId)

  // Create contact from lead
  const contact = await r.contacts.create({
    orgId,
    type: 'customer',
    companyName: lead.companyName,
    firstName: lead.contactName.split(' ')[0] || lead.contactName,
    lastName: lead.contactName.split(' ').slice(1).join(' ') || '',
    email: lead.email,
    phone: lead.phone,
    website: lead.website,
    isActive: true,
    paymentTermsDays: 30,
  } as any)

  let deal: IDeal | undefined
  if (options.createDeal) {
    const pipeline = options.pipelineId
      ? await r.pipelines.findById(options.pipelineId)
      : await r.pipelines.findOne({ orgId, isDefault: true } as any)

    if (pipeline && pipeline.stages.length > 0) {
      deal = await r.deals.create({
        orgId,
        name: `${lead.companyName || lead.contactName} - New Deal`,
        contactId: contact.id,
        stage: pipeline.stages[0].name,
        pipelineId: pipeline.id,
        value: options.dealValue || lead.estimatedValue || 0,
        currency: lead.currency || 'EUR',
        probability: pipeline.stages[0].probability,
        status: 'open',
        assignedTo: lead.assignedTo,
      } as any) as IDeal
    }
  }

  await r.leads.update(lead.id, {
    status: 'converted',
    convertedToContactId: contact.id,
    convertedToDealId: deal ? deal.id : undefined,
    convertedAt: new Date(),
  } as any)

  logger.info({ leadId, contactId: contact.id }, 'Lead converted')
  return { contact, deal }
}

export async function moveDealStage(
  dealId: string,
  newStage: string,
  repos?: RepositoryRegistry,
): Promise<IDeal> {
  const r = repos ?? getRepos()

  const deal = await r.deals.findById(dealId)
  if (!deal) throw new Error('Deal not found')

  const pipeline = await r.pipelines.findById(deal.pipelineId)
  if (!pipeline) throw new Error('Pipeline not found')

  const stage = pipeline.stages.find(s => s.name === newStage)
  if (!stage) throw new Error(`Stage "${newStage}" not found in pipeline`)

  const updated = await r.deals.update(dealId, {
    stage: newStage,
    probability: stage.probability,
  } as any)
  if (!updated) throw new Error('Failed to update deal stage')

  logger.info({ dealId, newStage }, 'Deal stage updated')
  return updated
}

export async function getPipelineSummary(orgId: string, pipelineId: string, repos?: RepositoryRegistry) {
  const r = repos ?? getRepos()

  const pipeline = await r.pipelines.findById(pipelineId)
  if (!pipeline) throw new Error('Pipeline not found')

  const deals = await r.deals.findMany({ orgId, pipelineId, status: 'open' } as any)

  const stages = pipeline.stages.map(stage => {
    const stageDeals = deals.filter(d => d.stage === stage.name)
    return {
      name: stage.name,
      order: stage.order,
      color: stage.color,
      dealCount: stageDeals.length,
      totalValue: stageDeals.reduce((sum, d) => sum + d.value, 0),
      weightedValue: stageDeals.reduce((sum, d) => sum + d.value * d.probability / 100, 0),
    }
  })

  return {
    pipeline: { id: pipeline.id, name: pipeline.name },
    stages,
    totalDeals: deals.length,
    totalValue: deals.reduce((sum, d) => sum + d.value, 0),
    totalWeightedValue: stages.reduce((sum, s) => sum + s.weightedValue, 0),
  }
}
