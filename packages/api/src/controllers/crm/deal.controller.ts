import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { Deal } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const dealController = new Elysia({ prefix: '/org/:orgId/crm/deal' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.pipelineId) filter.pipelineId = query.pipelineId
    if (query.assignedTo) filter.assignedTo = query.assignedTo
    if (query.stage) filter.stage = query.stage

    const result = await paginateQuery(Deal, filter, query)
    return { deals: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const deal = await Deal.create({
        ...body,
        orgId,
        status: 'open',
        assignedTo: body.assignedTo || user.id,
      })

      return deal.toJSON()
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        contactId: t.String(),
        stage: t.String(),
        pipelineId: t.String(),
        value: t.Number(),
        currency: t.String(),
        probability: t.Number({ minimum: 0, maximum: 100 }),
        expectedCloseDate: t.Optional(t.String()),
        assignedTo: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const deal = await Deal.findOne({ _id: id, orgId })
      .populate('contactId', 'companyName firstName lastName email')
      .lean()
      .exec()
    if (!deal) return status(404, { message: 'Deal not found' })

    return deal
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const deal = await Deal.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!deal) return status(404, { message: 'Deal not found' })

      return deal
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        value: t.Optional(t.Number()),
        currency: t.Optional(t.String()),
        probability: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        expectedCloseDate: t.Optional(t.String()),
        status: t.Optional(t.Union([
          t.Literal('open'),
          t.Literal('won'),
          t.Literal('lost'),
        ])),
        lostReason: t.Optional(t.String()),
        assignedTo: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const deal = await Deal.findOneAndDelete({ _id: id, orgId }).exec()
    if (!deal) return status(404, { message: 'Deal not found' })

    return { message: 'Deal deleted' }
  }, { isSignIn: true })
  .put(
    '/:id/stage',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const deal = await Deal.findOne({ _id: id, orgId }).exec()
      if (!deal) return status(404, { message: 'Deal not found' })
      if (deal.status !== 'open')
        return status(400, { message: 'Can only move open deals' })

      deal.stage = body.stage
      if (body.probability !== undefined) deal.probability = body.probability
      await deal.save()

      return deal.toJSON()
    },
    {
      isSignIn: true,
      body: t.Object({
        stage: t.String({ minLength: 1 }),
        probability: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
      }),
    },
  )
