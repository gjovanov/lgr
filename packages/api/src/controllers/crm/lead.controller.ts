import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { Lead, Contact, Deal } from 'db/models'

export const leadController = new Elysia({ prefix: '/org/:orgId/crm/lead' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.source) filter.source = query.source
    if (query.assignedTo) filter.assignedTo = query.assignedTo

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).exec(),
      Lead.countDocuments(filter).exec(),
    ])

    return { leads: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const lead = await Lead.create({ ...body, orgId })
      return lead.toJSON()
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

    const lead = await Lead.findOne({ _id: id, orgId }).lean().exec()
    if (!lead) return status(404, { message: 'Lead not found' })

    return lead
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const lead = await Lead.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!lead) return status(404, { message: 'Lead not found' })

      return lead
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

    const lead = await Lead.findOneAndDelete({ _id: id, orgId }).exec()
    if (!lead) return status(404, { message: 'Lead not found' })

    return { message: 'Lead deleted' }
  }, { isSignIn: true })
  .post(
    '/:id/convert',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const lead = await Lead.findOne({ _id: id, orgId }).exec()
      if (!lead) return status(404, { message: 'Lead not found' })
      if (lead.status === 'converted')
        return status(400, { message: 'Lead already converted' })

      // Create contact from lead
      const contact = await Contact.create({
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
      })

      // Create deal from lead
      const deal = await Deal.create({
        orgId,
        name: `Deal - ${lead.companyName || lead.contactName}`,
        contactId: contact._id,
        stage: body.stage || 'Qualification',
        pipelineId: body.pipelineId,
        value: lead.estimatedValue || 0,
        currency: lead.currency || 'EUR',
        probability: 20,
        status: 'open',
        assignedTo: lead.assignedTo || user.id,
      })

      // Update lead status
      lead.status = 'converted'
      lead.convertedToContactId = contact._id
      lead.convertedToDealId = deal._id
      lead.convertedAt = new Date()
      await lead.save()

      return { lead, contact, deal }
    },
    {
      isSignIn: true,
      body: t.Object({
        pipelineId: t.String(),
        stage: t.Optional(t.String()),
      }),
    },
  )
