import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const slaPolicyController = new Elysia({ prefix: '/org/:orgId/helpdesk/sla-policies' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.read')) {
      return status(403, { message: 'Forbidden: helpdesk.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'
    if (query.teamId) filter.teamId = query.teamId
    if (query.priority) filter.priority = query.priority

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 50
    const result = await r.slaPolicies.findAll(filter, { page, size, sort: { name: 1 } })

    return {
      slaPolicies: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.manage')) {
      return status(403, { message: 'Forbidden: helpdesk.manage permission required' })
    }
    const r = getRepos()

    const policy = await r.slaPolicies.create({
      orgId,
      name: body.name,
      teamId: body.teamId,
      priority: body.priority,
      targets: body.targets,
      businessHoursOnly: body.businessHoursOnly ?? false,
      escalateTo: body.escalateTo,
      isActive: true,
    } as any)

    createAuditEntry(r, {
      orgId, userId: user.id, action: 'create', entityType: 'SLAPolicy',
      entityId: policy.id, entityName: body.name, newValues: policy,
    }).catch(() => {})

    return policy
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String({ minLength: 1 }),
      teamId: t.Optional(t.String()),
      priority: t.String(),
      targets: t.Object({
        firstResponseHours: t.Optional(t.Number({ minimum: 0.1 })),
        resolutionHours: t.Optional(t.Number({ minimum: 0.1 })),
      }),
      businessHoursOnly: t.Optional(t.Boolean()),
      escalateTo: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.manage')) {
      return status(403, { message: 'Forbidden: helpdesk.manage permission required' })
    }
    const r = getRepos()

    const existing = await r.slaPolicies.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'SLA policy not found' })

    const updated = await r.slaPolicies.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry(r, {
        orgId, userId: user.id, action: 'update', entityType: 'SLAPolicy',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      teamId: t.Optional(t.String()),
      priority: t.Optional(t.String()),
      targets: t.Optional(t.Object({
        firstResponseHours: t.Optional(t.Number({ minimum: 0.1 })),
        resolutionHours: t.Optional(t.Number({ minimum: 0.1 })),
      })),
      businessHoursOnly: t.Optional(t.Boolean()),
      escalateTo: t.Optional(t.String()),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.manage')) {
      return status(403, { message: 'Forbidden: helpdesk.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.slaPolicies.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'SLA policy not found' })

    await r.slaPolicies.delete(id)

    createAuditEntry(r, {
      orgId, userId: user.id, action: 'delete', entityType: 'SLAPolicy',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { isSignIn: true })
