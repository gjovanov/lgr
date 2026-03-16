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

export const dealController = new Elysia({ prefix: '/org/:orgId/crm/deal' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.pipelineId) filter.pipelineId = query.pipelineId
    if (query.assignedTo) filter.assignedTo = query.assignedTo
    if (query.stage) filter.stage = query.stage
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.deals.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { deals: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const deal = await r.deals.create({
        ...body,
        orgId,
        status: 'open',
        assignedTo: body.assignedTo || user.id,
      } as any)
      await upsertTags(orgId, 'deal', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'crm', entityType: 'deal', entityId: deal.id, entityName: (deal as any).name })

      return { deal }
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
    const r = getRepos()

    const deal = await r.deals.findOne({ id, orgId } as any)
    if (!deal) return status(404, { message: 'Deal not found' })

    // Manual batch lookup for contact
    if ((deal as any).contactId) {
      const contact = await r.contacts.findById((deal as any).contactId)
      if (contact) {
        ;(deal as any).contactId = {
          _id: contact.id,
          id: contact.id,
          companyName: (contact as any).companyName,
          firstName: (contact as any).firstName,
          lastName: (contact as any).lastName,
          email: (contact as any).email,
        }
      }
    }

    return { deal }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.deals.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Deal not found' })

      const deal = await r.deals.update(id, body as any)
      await upsertTags(orgId, 'deal', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'crm', entityType: 'deal', entityId: id, entityName: (deal as any).name, changes: diffChanges(existing as any, deal as any) })

      return { deal }
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
    const r = getRepos()

    const existing = await r.deals.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Deal not found' })

    await r.deals.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'crm', entityType: 'deal', entityId: id, entityName: (existing as any).name })

    return { message: 'Deal deleted' }
  }, { isSignIn: true })
  .put(
    '/:id/stage',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const deal = await r.deals.findOne({ id, orgId } as any)
      if (!deal) return status(404, { message: 'Deal not found' })
      if (deal.status !== 'open')
        return status(400, { message: 'Can only move open deals' })

      const updateData: Record<string, any> = { stage: body.stage }
      if (body.probability !== undefined) updateData.probability = body.probability

      const updated = await r.deals.update(id, updateData as any)

      createAuditEntry({ orgId, userId: user.id, action: 'stage_change', module: 'crm', entityType: 'deal', entityId: id, entityName: (deal as any).name, changes: diffChanges(deal as any, updated as any) })

      return { deal: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        stage: t.String({ minLength: 1 }),
        probability: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
      }),
    },
  )
