import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Activity } from 'db/models'

export const activityController = new Elysia({ prefix: '/org/:orgId/crm/activity' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.status) filter.status = query.status
    if (query.contactId) filter.contactId = query.contactId
    if (query.dealId) filter.dealId = query.dealId
    if (query.assignedTo) filter.assignedTo = query.assignedTo

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      Activity.find(filter).sort({ dueDate: 1, createdAt: -1 }).skip(skip).limit(pageSize).exec(),
      Activity.countDocuments(filter).exec(),
    ])

    return { activities: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
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

      return { activity: activity.toJSON() }
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

    return { activity }
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

    return { activity: activity.toJSON() }
  }, { isSignIn: true })
