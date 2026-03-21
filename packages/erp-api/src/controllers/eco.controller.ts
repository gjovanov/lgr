import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const ecoController = new Elysia({ prefix: '/org/:orgId/erp/ecos' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('erp.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'description'])
      Object.assign(filter, searchFilter)
    }
    if (query.state) filter.state = query.state
    if (query.type) filter.type = query.type
    if (query.productId) filter.productId = query.productId

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.ecos.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { ecos: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('erp.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const eco = await r.ecos.create({
        ...body,
        orgId,
        state: 'draft',
        createdBy: user.id,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'eco', entityId: eco.id, entityName: (eco as any).name })

      return { eco }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        productId: t.String(),
        bomId: t.Optional(t.String()),
        type: t.Union([
          t.Literal('bom_change'),
          t.Literal('routing_change'),
          t.Literal('product_change'),
        ]),
        description: t.Optional(t.String()),
        changes: t.Optional(t.Array(t.Object({
          field: t.String(),
          oldValue: t.Optional(t.String()),
          newValue: t.Optional(t.String()),
        }))),
        requesterId: t.String(),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('erp.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const eco = await r.ecos.findOne({ id, orgId } as any)
    if (!eco) return status(404, { message: 'ECO not found' })

    return { eco }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('erp.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.ecos.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'ECO not found' })
      if ((existing as any).state !== 'draft')
        return status(400, { message: 'Only draft ECOs can be edited' })

      const eco = await r.ecos.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'eco', entityId: id, entityName: (eco as any).name, changes: diffChanges(existing as any, eco as any) })

      return { eco }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        changes: t.Optional(t.Array(t.Object({
          field: t.String(),
          oldValue: t.Optional(t.String()),
          newValue: t.Optional(t.String()),
        }))),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('erp.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.ecos.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'ECO not found' })
    if ((existing as any).state !== 'draft')
      return status(400, { message: 'Only draft ECOs can be deleted' })

    await r.ecos.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'eco', entityId: id, entityName: (existing as any).name })

    return { message: 'ECO deleted' }
  }, { isSignIn: true })

  // State transitions using DAL findOneAndUpdate
  .post('/:id/submit', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('erp.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const eco = await r.ecos.findOneAndUpdate(
      { id, orgId, state: 'draft' } as any,
      { state: 'in_review' } as any,
    )

    if (!eco) return status(400, { message: 'ECO not found or not in draft state' })

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'eco', entityId: id, entityName: (eco as any).name, changes: [{ field: 'state', oldValue: 'draft', newValue: 'in_review' }] })

    return { eco }
  }, { isSignIn: true })

  .post('/:id/approve', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('erp.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const eco = await r.ecos.findOneAndUpdate(
      { id, orgId, state: 'in_review' } as any,
      { state: 'approved', reviewerId: user.id, approvedDate: new Date() } as any,
    )

    if (!eco) return status(400, { message: 'ECO not found or not in review state' })

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'eco', entityId: id, entityName: (eco as any).name, changes: [{ field: 'state', oldValue: 'in_review', newValue: 'approved' }] })

    return { eco }
  }, { isSignIn: true })

  .post('/:id/apply', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('erp.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const eco = await r.ecos.findOneAndUpdate(
      { id, orgId, state: 'approved' } as any,
      { state: 'applied', appliedDate: new Date() } as any,
    )

    if (!eco) return status(400, { message: 'ECO not found or not in approved state' })

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'eco', entityId: id, entityName: (eco as any).name, changes: [{ field: 'state', oldValue: 'approved', newValue: 'applied' }] })

    return { eco }
  }, { isSignIn: true })

  .post('/:id/reject', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('erp.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const eco = await r.ecos.findOneAndUpdate(
      { id, orgId, state: 'in_review' } as any,
      { state: 'rejected', reviewerId: user.id } as any,
    )

    if (!eco) return status(400, { message: 'ECO not found or not in review state' })

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'eco', entityId: id, entityName: (eco as any).name, changes: [{ field: 'state', oldValue: 'in_review', newValue: 'rejected' }] })

    return { eco }
  }, { isSignIn: true })
