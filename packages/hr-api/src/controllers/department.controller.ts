import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const departmentController = new Elysia({ prefix: '/org/:orgId/hr/department' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.departments.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { departments: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })
      const r = getRepos()

      const dept = await r.departments.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'hr', entityType: 'department', entityId: dept.id, entityName: (dept as any).name })

      return { department: dept }
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
    const r = getRepos()

    const dept = await r.departments.findOne({ id, orgId } as any)
    if (!dept) return status(404, { message: 'Department not found' })

    return { department: dept }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Admin or HR manager only' })
      const r = getRepos()

      const existing = await r.departments.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Department not found' })

      const dept = await r.departments.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'department', entityId: id, entityName: (dept as any).name, changes: diffChanges(existing as any, dept as any) })

      return { department: dept }
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
    const r = getRepos()

    const existing = await r.departments.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Department not found' })

    await r.departments.update(id, { isActive: false } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'hr', entityType: 'department', entityId: id, entityName: (existing as any).name })

    return { message: 'Department deactivated' }
  }, { isSignIn: true })
