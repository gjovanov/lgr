import { Elysia, t } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { Activity } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const activityController = new Elysia({ prefix: '/org/:orgId/crm/activity' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.status) filter.status = query.status
    if (query.contactId) filter.contactId = query.contactId
    if (query.dealId) filter.dealId = query.dealId
    if (query.assignedTo) filter.assignedTo = query.assignedTo

    const result = await paginateQuery(Activity, filter, query)
    return { activities: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const activity = await Activity.create({
        ...body,
        orgId,
        assignedTo: body.assignedTo || user.id,
      })

      return activity.toJSON()
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

    const activity = await Activity.findOne({ _id: id, orgId }).lean().exec()
    if (!activity) return status(404, { message: 'Activity not found' })

    return activity
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const activity = await Activity.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!activity) return status(404, { message: 'Activity not found' })

      return activity
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

    const activity = await Activity.findOneAndDelete({ _id: id, orgId }).exec()
    if (!activity) return status(404, { message: 'Activity not found' })

    return { message: 'Activity deleted' }
  }, { isSignIn: true })
  .post('/:id/complete', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const activity = await Activity.findOne({ _id: id, orgId }).exec()
    if (!activity) return status(404, { message: 'Activity not found' })
    if (activity.status === 'completed')
      return status(400, { message: 'Activity already completed' })

    activity.status = 'completed'
    activity.completedAt = new Date()
    await activity.save()

    return activity.toJSON()
  }, { isSignIn: true })
