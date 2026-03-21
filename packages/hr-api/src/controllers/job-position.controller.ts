import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const jobPositionController = new Elysia({ prefix: '/org/:orgId/hr/job-positions' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.read') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'description'])
      Object.assign(filter, searchFilter)
    }
    if (query.state) filter.state = query.state
    if (query.departmentId) filter.departmentId = query.departmentId

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.jobPositions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { jobPositions: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('recruitment.write') && !['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      if (body.salaryMin !== undefined && body.salaryMax !== undefined && body.salaryMin > body.salaryMax)
        return status(400, { message: 'salaryMin cannot exceed salaryMax' })
      if (body.expectedHires !== undefined && body.expectedHires < 1)
        return status(400, { message: 'expectedHires must be at least 1' })

      const position = await r.jobPositions.create({
        ...body,
        orgId,
        state: 'draft',
        hiredCount: 0,
        createdBy: user.id,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'hr', entityType: 'job_position', entityId: position.id, entityName: (position as any).name })

      return { jobPosition: position }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        departmentId: t.String(),
        description: t.Optional(t.String()),
        requirements: t.Optional(t.String()),
        salaryMin: t.Optional(t.Number({ minimum: 0 })),
        salaryMax: t.Optional(t.Number({ minimum: 0 })),
        salaryCurrency: t.Optional(t.String()),
        expectedHires: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.read') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const position = await r.jobPositions.findOne({ id, orgId } as any)
    if (!position) return status(404, { message: 'Job position not found' })

    return { jobPosition: position }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('recruitment.write') && !['admin', 'hr_manager'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.jobPositions.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Job position not found' })

      if (body.salaryMin !== undefined && body.salaryMax !== undefined && body.salaryMin > body.salaryMax)
        return status(400, { message: 'salaryMin cannot exceed salaryMax' })

      const position = await r.jobPositions.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'job_position', entityId: id, entityName: (position as any).name, changes: diffChanges(existing as any, position as any) })

      return { jobPosition: position }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        departmentId: t.Optional(t.String()),
        description: t.Optional(t.String()),
        requirements: t.Optional(t.String()),
        salaryMin: t.Optional(t.Number({ minimum: 0 })),
        salaryMax: t.Optional(t.Number({ minimum: 0 })),
        salaryCurrency: t.Optional(t.String()),
        expectedHires: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.manage') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.jobPositions.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Job position not found' })

    await r.jobPositions.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'hr', entityType: 'job_position', entityId: id, entityName: (existing as any).name })

    return { message: 'Job position deactivated' }
  }, { isSignIn: true })
  .post('/:id/publish', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.manage') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.jobPositions.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Job position not found' })
    if ((existing as any).state !== 'draft')
      return status(400, { message: 'Only draft positions can be published' })

    const position = await r.jobPositions.update(id, { state: 'published', publishedDate: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'job_position', entityId: id, entityName: (position as any).name, changes: [{ field: 'state', before: 'draft', after: 'published' }] })

    return { jobPosition: position }
  }, { isSignIn: true })
  .post('/:id/close', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('recruitment.manage') && !['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.jobPositions.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Job position not found' })
    if ((existing as any).state !== 'published')
      return status(400, { message: 'Only published positions can be closed' })

    const position = await r.jobPositions.update(id, { state: 'closed', closingDate: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'job_position', entityId: id, entityName: (position as any).name, changes: [{ field: 'state', before: 'published', after: 'closed' }] })

    return { jobPosition: position }
  }, { isSignIn: true })
