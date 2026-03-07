import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const activityController = new Elysia({ prefix: '/org/:orgId/crm/activity' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.status) filter.status = query.status
    if (query.contactId) filter.contactId = query.contactId
    if (query.dealId) filter.dealId = query.dealId
    if (query.assignedTo) filter.assignedTo = query.assignedTo

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.activities.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { activities: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const activity = await r.activities.create({
        ...body,
        orgId,
        assignedTo: body.assignedTo || user.id,
      } as any)

      return { activity }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Union([
          t.Literal('call'),
          t.Literal('email'),
          t.Literal('meeting'),
          t.Literal('task'),
          t.Literal('note'),
          t.Literal('follow_up'),
        ]),
        subject: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        dealId: t.Optional(t.String()),
        leadId: t.Optional(t.String()),
        assignedTo: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        priority: t.Optional(t.Union([
          t.Literal('low'),
          t.Literal('medium'),
          t.Literal('high'),
        ])),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const activity = await r.activities.findOne({ id, orgId } as any)
    if (!activity) return status(404, { message: 'Activity not found' })

    return { activity }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.activities.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Activity not found' })

      const activity = await r.activities.update(id, body as any)
      return { activity }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Optional(t.Union([
          t.Literal('call'),
          t.Literal('email'),
          t.Literal('meeting'),
          t.Literal('task'),
          t.Literal('note'),
          t.Literal('follow_up'),
        ])),
        subject: t.Optional(t.String()),
        description: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        dealId: t.Optional(t.String()),
        leadId: t.Optional(t.String()),
        assignedTo: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        priority: t.Optional(t.Union([
          t.Literal('low'),
          t.Literal('medium'),
          t.Literal('high'),
        ])),
        outcome: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.activities.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Activity not found' })

    await r.activities.delete(id)
    return { message: 'Activity deleted' }
  }, { isSignIn: true })
  .post('/:id/complete', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const activity = await r.activities.findOne({ id, orgId } as any)
    if (!activity) return status(404, { message: 'Activity not found' })
    if (activity.status === 'completed')
      return status(400, { message: 'Activity already completed' })

    const updated = await r.activities.update(id, {
      status: 'completed',
      completedAt: new Date(),
    } as any)

    return { activity: updated }
  }, { isSignIn: true })
