import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Department } from 'db/models'

export const departmentController = new Elysia({ prefix: '/org/:orgId/hr/department' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const departments = await Department.find({ orgId }).sort({ name: 1 }).exec()
    return { departments }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })

      const dept = await Department.create({ ...body, orgId })
      return dept.toJSON()
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        code: t.String({ minLength: 1 }),
        parentId: t.Optional(t.String()),
        headId: t.Optional(t.String()),
        description: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const dept = await Department.findOne({ _id: id, orgId }).lean().exec()
    if (!dept) return status(404, { message: 'Department not found' })

    return dept
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })

      const dept = await Department.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!dept) return status(404, { message: 'Department not found' })

      return dept
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        code: t.Optional(t.String()),
        parentId: t.Optional(t.String()),
        headId: t.Optional(t.String()),
        description: t.Optional(t.String()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })

    const dept = await Department.findOneAndUpdate(
      { _id: id, orgId },
      { isActive: false },
      { new: true },
    ).exec()
    if (!dept) return status(404, { message: 'Department not found' })

    return { message: 'Department deactivated' }
  }, { isSignIn: true })
