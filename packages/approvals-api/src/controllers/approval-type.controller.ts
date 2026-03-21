import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'entityType']

export const approvalTypeController = new Elysia({ prefix: '/org/:orgId/approvals/types' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('approvals.manage')) {
      return status(403, { message: 'Forbidden: approvals.manage permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name']))
    }
    if (query.entityType) filter.entityType = query.entityType
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.approvalTypes.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      approvalTypes: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('approvals.manage')) {
      return status(403, { message: 'Forbidden: approvals.manage permission required' })
    }
    const r = getRepos()
    const type = await r.approvalTypes.findOne({ id, orgId } as any)
    if (!type) return status(404, { message: 'Approval type not found' })
    return type
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('approvals.manage')) {
      return status(403, { message: 'Forbidden: approvals.manage permission required' })
    }
    const r = getRepos()

    const type = await r.approvalTypes.create({
      orgId,
      name: body.name,
      entityType: body.entityType,
      description: body.description,
      steps: body.steps || [],
      isActive: body.isActive ?? true,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, action: 'create', module: 'approvals',
      entityType: 'ApprovalType', entityId: type.id, entityName: type.name,
    })

    return type
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String(),
      entityType: t.String(),
      description: t.Optional(t.String()),
      steps: t.Array(t.Object({
        order: t.Number({ minimum: 1 }),
        name: t.String(),
        approverType: t.String(),
        approverId: t.Optional(t.String()),
        approverRole: t.Optional(t.String()),
        required: t.Optional(t.Boolean()),
      })),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('approvals.manage')) {
      return status(403, { message: 'Forbidden: approvals.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.approvalTypes.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Approval type not found' })

    const updated = await r.approvalTypes.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, action: 'update', module: 'approvals',
        entityType: 'ApprovalType', entityId: id, entityName: existing.name, changes,
      })
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String()),
      entityType: t.Optional(t.String()),
      description: t.Optional(t.String()),
      steps: t.Optional(t.Array(t.Object({
        order: t.Number({ minimum: 1 }),
        name: t.String(),
        approverType: t.String(),
        approverId: t.Optional(t.String()),
        approverRole: t.Optional(t.String()),
        required: t.Optional(t.Boolean()),
      }))),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('approvals.manage')) {
      return status(403, { message: 'Forbidden: approvals.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.approvalTypes.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Approval type not found' })

    await r.approvalTypes.delete(id)

    createAuditEntry({
      orgId, userId: user.id, action: 'delete', module: 'approvals',
      entityType: 'ApprovalType', entityId: id, entityName: existing.name,
    })

    return { message: 'Deleted' }
  }, { isSignIn: true })
