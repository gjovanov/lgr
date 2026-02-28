import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { userDao } from 'services/dao/user.dao'
import { User } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

export const userController = new Elysia({ prefix: '/org/:orgId/user' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(User, filter, query)
    return { users: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const hashedPassword = await Bun.password.hash(body.password)
      const role = body.role || 'member'

      const created = await userDao.create({
        ...body,
        password: hashedPassword,
        role,
        orgId: orgId as unknown as import('mongoose').Types.ObjectId,
        isActive: true,
        permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || [],
      })

      return created
    },
    {
      isSignIn: true,
      body: t.Object({
        email: t.String({ format: 'email' }),
        username: t.String({ minLength: 3 }),
        password: t.String({ minLength: 6 }),
        firstName: t.String({ minLength: 1 }),
        lastName: t.String({ minLength: 1 }),
        role: t.Optional(t.Union([
          t.Literal('admin'),
          t.Literal('manager'),
          t.Literal('accountant'),
          t.Literal('hr_manager'),
          t.Literal('warehouse_manager'),
          t.Literal('sales'),
          t.Literal('member'),
        ])),
      }),
    },
  )
  .get('/:userId', async ({ params: { userId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const found = await userDao.findByIdSafe(userId)
    if (!found) return status(404, { message: 'User not found' })

    return found
  }, { isSignIn: true })
  .put(
    '/:userId',
    async ({ params: { userId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const updateData: Record<string, unknown> = { ...body }
      if (body.password) {
        updateData.password = await Bun.password.hash(body.password)
      }

      const updated = await userDao.update(userId, updateData)
      if (!updated) return status(404, { message: 'User not found' })

      return updated
    },
    {
      isSignIn: true,
      body: t.Object({
        email: t.Optional(t.String({ format: 'email' })),
        username: t.Optional(t.String({ minLength: 3 })),
        password: t.Optional(t.String({ minLength: 6 })),
        firstName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
        role: t.Optional(t.Union([
          t.Literal('admin'),
          t.Literal('manager'),
          t.Literal('accountant'),
          t.Literal('hr_manager'),
          t.Literal('warehouse_manager'),
          t.Literal('sales'),
          t.Literal('member'),
        ])),
        isActive: t.Optional(t.Boolean()),
        permissions: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .delete('/:userId', async ({ params: { userId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

    await userDao.delete(userId)
    return { message: 'User deleted' }
  }, { isSignIn: true })
