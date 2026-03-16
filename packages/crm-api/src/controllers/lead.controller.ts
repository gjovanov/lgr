import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

async function upsertTags(orgId: string, type: string, tags?: string[]) {
  if (!tags?.length) return
  const r = getRepos()
  for (const value of tags) {
    const existing = await r.tags.findOne({ orgId, type, value } as any)
    if (!existing) await r.tags.create({ orgId, type, value } as any)
  }
}

export const leadController = new Elysia({ prefix: '/org/:orgId/crm/lead' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.source) filter.source = query.source
    if (query.assignedTo) filter.assignedTo = query.assignedTo
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.leads.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { leads: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const lead = await r.leads.create({ ...body, orgId } as any)
      await upsertTags(orgId, 'lead', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'crm', entityType: 'lead', entityId: lead.id, entityName: (lead as any).companyName || (lead as any).contactName })

      return { lead }
    },
    {
      isSignIn: true,
      body: t.Object({
        source: t.Union([
          t.Literal('website'),
          t.Literal('referral'),
          t.Literal('cold_call'),
          t.Literal('email'),
          t.Literal('social'),
          t.Literal('event'),
          t.Literal('other'),
        ]),
        contactName: t.String({ minLength: 1 }),
        companyName: t.Optional(t.String()),
        email: t.Optional(t.String({ format: 'email' })),
        phone: t.Optional(t.String()),
        website: t.Optional(t.String()),
        industry: t.Optional(t.String()),
        estimatedValue: t.Optional(t.Number()),
        currency: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        assignedTo: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const lead = await r.leads.findOne({ id, orgId } as any)
    if (!lead) return status(404, { message: 'Lead not found' })

    return { lead }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.leads.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Lead not found' })

      const lead = await r.leads.update(id, body as any)
      await upsertTags(orgId, 'lead', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'crm', entityType: 'lead', entityId: id, entityName: (lead as any).companyName || (lead as any).contactName, changes: diffChanges(existing as any, lead as any) })

      return { lead }
    },
    {
      isSignIn: true,
      body: t.Object({
        source: t.Optional(t.Union([
          t.Literal('website'),
          t.Literal('referral'),
          t.Literal('cold_call'),
          t.Literal('email'),
          t.Literal('social'),
          t.Literal('event'),
          t.Literal('other'),
        ])),
        status: t.Optional(t.Union([
          t.Literal('new'),
          t.Literal('contacted'),
          t.Literal('qualified'),
          t.Literal('unqualified'),
        ])),
        contactName: t.Optional(t.String()),
        companyName: t.Optional(t.String()),
        email: t.Optional(t.String({ format: 'email' })),
        phone: t.Optional(t.String()),
        estimatedValue: t.Optional(t.Number()),
        currency: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        assignedTo: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.leads.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Lead not found' })

    await r.leads.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'crm', entityType: 'lead', entityId: id, entityName: (existing as any).companyName || (existing as any).contactName })

    return { message: 'Lead deleted' }
  }, { isSignIn: true })
  .post(
    '/:id/convert',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const lead = await r.leads.findOne({ id, orgId } as any)
      if (!lead) return status(404, { message: 'Lead not found' })
      if (lead.status === 'converted')
        return status(400, { message: 'Lead already converted' })

      // Create contact from lead
      const contact = await r.contacts.create({
        orgId,
        type: 'customer',
        companyName: lead.companyName,
        firstName: lead.contactName.split(' ')[0],
        lastName: lead.contactName.split(' ').slice(1).join(' ') || '',
        email: lead.email,
        phone: lead.phone,
        website: lead.website,
        isActive: true,
        paymentTermsDays: 30,
      } as any)

      // Create deal from lead
      const deal = await r.deals.create({
        orgId,
        name: `Deal - ${lead.companyName || lead.contactName}`,
        contactId: contact.id,
        stage: body.stage || 'Qualification',
        pipelineId: body.pipelineId,
        value: lead.estimatedValue || 0,
        currency: lead.currency || 'EUR',
        probability: 20,
        status: 'open',
        assignedTo: lead.assignedTo || user.id,
      } as any)

      // Update lead status
      const updatedLead = await r.leads.update(id, {
        status: 'converted',
        convertedToContactId: contact.id,
        convertedToDealId: deal.id,
        convertedAt: new Date(),
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'convert', module: 'crm', entityType: 'lead', entityId: id, entityName: lead.companyName || lead.contactName })

      return { lead: updatedLead, contact, deal }
    },
    {
      isSignIn: true,
      body: t.Object({
        pipelineId: t.String(),
        stage: t.Optional(t.String()),
      }),
    },
  )
