import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { Notification } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const notificationController = new Elysia({ prefix: '/org/:orgId/notification' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId, userId: user.id }
    if (query.read !== undefined) filter.read = query.read === 'true'
    if (query.module) filter.module = query.module

    const result = await paginateQuery(Notification, filter, query)
    return { notifications: result.items, ...result }
  }, { isSignIn: true })
  .put('/:id/read', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const notification = await Notification.findOneAndUpdate(
      { _id: id, orgId, userId: user.id },
      { read: true, readAt: new Date() },
      { new: true },
    ).exec()
    if (!notification) return status(404, { message: 'Notification not found' })

    return notification
  }, { isSignIn: true })
  .put('/read-all', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    await Notification.updateMany(
      { orgId, userId: user.id, read: false },
      { read: true, readAt: new Date() },
    ).exec()

    return { message: 'All notifications marked as read' }
  }, { isSignIn: true })
