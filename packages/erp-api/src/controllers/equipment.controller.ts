import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const equipmentController = new Elysia({ prefix: '/org/:orgId/erp/equipment' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'serialNumber', 'location'])
      Object.assign(filter, searchFilter)
    }
    if (query.categoryId) filter.categoryId = query.categoryId
    if (query.assignedToId) filter.assignedToId = query.assignedToId

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.equipment.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { equipment: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('maintenance.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const equip = await r.equipment.create({
        ...body,
        orgId,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'equipment', entityId: equip.id, entityName: (equip as any).name })

      return { equipment: equip }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        categoryId: t.Optional(t.String()),
        location: t.Optional(t.String()),
        assignedToId: t.Optional(t.String()),
        serialNumber: t.Optional(t.String()),
        purchaseDate: t.Optional(t.String()),
        warrantyExpiry: t.Optional(t.String()),
        maintenanceTeamId: t.Optional(t.String()),
        expectedMTBF: t.Optional(t.Number({ minimum: 0 })),
        mttr: t.Optional(t.Number({ minimum: 0 })),
        nextPreventiveDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const equip = await r.equipment.findOne({ id, orgId } as any)
    if (!equip) return status(404, { message: 'Equipment not found' })

    return { equipment: equip }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('maintenance.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.equipment.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Equipment not found' })

      const equip = await r.equipment.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'equipment', entityId: id, entityName: (equip as any).name, changes: diffChanges(existing as any, equip as any) })

      return { equipment: equip }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        categoryId: t.Optional(t.String()),
        location: t.Optional(t.String()),
        assignedToId: t.Optional(t.String()),
        serialNumber: t.Optional(t.String()),
        purchaseDate: t.Optional(t.String()),
        warrantyExpiry: t.Optional(t.String()),
        maintenanceTeamId: t.Optional(t.String()),
        expectedMTBF: t.Optional(t.Number({ minimum: 0 })),
        mttr: t.Optional(t.Number({ minimum: 0 })),
        nextPreventiveDate: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.equipment.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Equipment not found' })

    await r.equipment.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'equipment', entityId: id, entityName: (existing as any).name })

    return { message: 'Equipment deleted' }
  }, { isSignIn: true })
