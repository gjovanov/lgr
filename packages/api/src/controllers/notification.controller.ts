import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { Notification } from 'db/models'

export const notificationController = new Elysia({ prefix: '/org/:orgId/notification' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId, userId: user.id }
    if (query.read !== undefined) filter.read = query.read === 'true'
    if (query.module) filter.module = query.module

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).exec(),
      Notification.countDocuments(filter).exec(),
    ])

    return { notifications: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .put('/:id/read', async ({ params: { orgId, id }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    const notification = await Notification.findOneAndUpdate(
      { _id: id, orgId, userId: user.id },
      { read: true, readAt: new Date() },
      { new: true },
    ).exec()
    if (!notification) return error(404, { message: 'Notification not found' })

    return notification
  }, { isSignIn: true })
  .put('/read-all', async ({ params: { orgId }, user, error }) => {
    if (!user) return error(401, { message: 'Unauthorized' })

    await Notification.updateMany(
      { orgId, userId: user.id, read: false },
      { read: true, readAt: new Date() },
    ).exec()

    return { message: 'All notifications marked as read' }
  }, { isSignIn: true })
