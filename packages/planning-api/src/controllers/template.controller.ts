import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name']

export const shiftTemplateController = new Elysia({ prefix: '/org/:orgId/planning/templates' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('planning.manage')) {
      return status(403, { message: 'Forbidden: planning.manage permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.shiftTemplates.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      shiftTemplates: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('planning.manage')) {
      return status(403, { message: 'Forbidden: planning.manage permission required' })
    }
    const r = getRepos()
    const tpl = await r.shiftTemplates.findOne({ id, orgId } as any)
    if (!tpl) return status(404, { message: 'Shift template not found' })
    return tpl
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('planning.manage')) {
      return status(403, { message: 'Forbidden: planning.manage permission required' })
    }
    const r = getRepos()

    const tpl = await r.shiftTemplates.create({
      orgId,
      name: body.name,
      entries: body.entries || [],
      isActive: body.isActive ?? true,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, action: 'create', module: 'planning',
      entityType: 'ShiftTemplate', entityId: tpl.id, entityName: tpl.name,
    })

    return tpl
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String(),
      entries: t.Array(t.Object({
        roleId: t.Optional(t.String()),
        dayOfWeek: t.Number({ minimum: 0, maximum: 6 }),
        startTime: t.String(),
        endTime: t.String(),
      })),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('planning.manage')) {
      return status(403, { message: 'Forbidden: planning.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.shiftTemplates.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Shift template not found' })

    const updated = await r.shiftTemplates.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, action: 'update', module: 'planning',
        entityType: 'ShiftTemplate', entityId: id, entityName: existing.name, changes,
      })
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String()),
      entries: t.Optional(t.Array(t.Object({
        roleId: t.Optional(t.String()),
        dayOfWeek: t.Number({ minimum: 0, maximum: 6 }),
        startTime: t.String(),
        endTime: t.String(),
      }))),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('planning.manage')) {
      return status(403, { message: 'Forbidden: planning.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.shiftTemplates.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Shift template not found' })

    await r.shiftTemplates.delete(id)

    createAuditEntry({
      orgId, userId: user.id, action: 'delete', module: 'planning',
      entityType: 'ShiftTemplate', entityId: id, entityName: existing.name,
    })

    return { message: 'Deleted' }
  }, { isSignIn: true })
