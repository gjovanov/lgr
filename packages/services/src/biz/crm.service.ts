import { Lead, Contact, Deal, Pipeline, type ILead, type IDeal } from 'db/models'
import { logger } from '../logger/logger.js'

export async function convertLead(
  leadId: string,
  options: { createDeal?: boolean; pipelineId?: string; dealValue?: number },
): Promise<{ contact: any; deal?: any }> {
  const lead = await Lead.findById(leadId)
  if (!lead) throw new Error('Lead not found')
  if (lead.status === 'converted') throw new Error('Lead already converted')

  const orgId = String(lead.orgId)

  // Create contact from lead
  const contact = await Contact.create({
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
  })

  let deal: IDeal | undefined
  if (options.createDeal) {
    const pipeline = options.pipelineId
      ? await Pipeline.findById(options.pipelineId)
      : await Pipeline.findOne({ orgId, isDefault: true })

    if (pipeline && pipeline.stages.length > 0) {
      deal = await Deal.create({
        orgId,
        name: `${lead.companyName || lead.contactName} - New Deal`,
        contactId: contact._id,
        stage: pipeline.stages[0].name,
        pipelineId: pipeline._id,
        value: options.dealValue || lead.estimatedValue || 0,
        currency: lead.currency || 'EUR',
        probability: pipeline.stages[0].probability,
        status: 'open',
        assignedTo: lead.assignedTo,
      }) as IDeal
    }
  }

  lead.status = 'converted'
  lead.convertedToContactId = contact._id
  if (deal) lead.convertedToDealId = deal._id
  lead.convertedAt = new Date()
  await lead.save()

  logger.info({ leadId, contactId: contact._id }, 'Lead converted')
  return { contact, deal }
}

export async function moveDealStage(
  dealId: string,
  newStage: string,
): Promise<IDeal> {
  const deal = await Deal.findById(dealId)
  if (!deal) throw new Error('Deal not found')

  const pipeline = await Pipeline.findById(deal.pipelineId)
  if (!pipeline) throw new Error('Pipeline not found')

  const stage = pipeline.stages.find(s => s.name === newStage)
  if (!stage) throw new Error(`Stage "${newStage}" not found in pipeline`)

  deal.stage = newStage
  deal.probability = stage.probability
  await deal.save()

  logger.info({ dealId, newStage }, 'Deal stage updated')
  return deal
}

export async function getPipelineSummary(orgId: string, pipelineId: string) {
  const pipeline = await Pipeline.findById(pipelineId)
  if (!pipeline) throw new Error('Pipeline not found')

  const deals = await Deal.find({ orgId, pipelineId, status: 'open' }).exec()

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
    pipeline: { id: pipeline._id, name: pipeline.name },
    stages,
    totalDeals: deals.length,
    totalValue: deals.reduce((sum, d) => sum + d.value, 0),
    totalWeightedValue: stages.reduce((sum, s) => sum + s.weightedValue, 0),
  }
}
