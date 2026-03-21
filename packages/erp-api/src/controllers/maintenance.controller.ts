import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const maintenanceController = new Elysia({ prefix: '/org/:orgId/erp/maintenance' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'description'])
      Object.assign(filter, searchFilter)
    }
    if (query.state) filter.state = query.state
    if (query.type) filter.type = query.type
    if (query.equipmentId) filter.equipmentId = query.equipmentId
    if (query.assigneeId) filter.assigneeId = query.assigneeId
    if (query.priority) filter.priority = query.priority

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'scheduledDate'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.maintenanceRequests.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { maintenanceRequests: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('maintenance.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      // Verify equipment exists
      const equip = await r.equipment.findOne({ id: body.equipmentId, orgId } as any)
      if (!equip) return status(404, { message: 'Equipment not found' })

      const request = await r.maintenanceRequests.create({
        ...body,
        orgId,
        state: 'draft',
        createdBy: user.id,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'maintenance_request', entityId: request.id, entityName: (request as any).name })

      return { maintenanceRequest: request }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        equipmentId: t.String(),
        type: t.Union([
          t.Literal('preventive'),
          t.Literal('corrective'),
          t.Literal('predictive'),
          t.Literal('condition_based'),
        ]),
        priority: t.Optional(t.Union([
          t.Literal('low'),
          t.Literal('normal'),
          t.Literal('high'),
          t.Literal('urgent'),
        ])),
        assigneeId: t.Optional(t.String()),
        scheduledDate: t.String(),
        description: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        isRecurring: t.Optional(t.Boolean()),
        recurringDays: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.read') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const request = await r.maintenanceRequests.findOne({ id, orgId } as any)
    if (!request) return status(404, { message: 'Maintenance request not found' })

    return { maintenanceRequest: request }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('maintenance.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.maintenanceRequests.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Maintenance request not found' })
      if (['done', 'cancelled'].includes((existing as any).state))
        return status(400, { message: 'Cannot edit completed or cancelled requests' })

      const request = await r.maintenanceRequests.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'maintenance_request', entityId: id, entityName: (request as any).name, changes: diffChanges(existing as any, request as any) })

      return { maintenanceRequest: request }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        priority: t.Optional(t.String()),
        assigneeId: t.Optional(t.String()),
        scheduledDate: t.Optional(t.String()),
        description: t.Optional(t.String()),
        notes: t.Optional(t.String()),
        isRecurring: t.Optional(t.Boolean()),
        recurringDays: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.manage') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.maintenanceRequests.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Maintenance request not found' })

    await r.maintenanceRequests.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'maintenance_request', entityId: id, entityName: (existing as any).name })

    return { message: 'Maintenance request deleted' }
  }, { isSignIn: true })
  .post('/:id/start', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.write') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.maintenanceRequests.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Maintenance request not found' })
    if (!['draft', 'confirmed'].includes((existing as any).state))
      return status(400, { message: 'Only draft or confirmed requests can be started' })

    const prevState = (existing as any).state
    const request = await r.maintenanceRequests.update(id, { state: 'in_progress' } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'maintenance_request', entityId: id, entityName: (request as any).name, changes: [{ field: 'state', before: prevState, after: 'in_progress' }] })

    return { maintenanceRequest: request }
  }, { isSignIn: true })
  .post(
    '/:id/complete',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('maintenance.write') && !['admin'].includes(user.role))
        return status(403, { message: 'Insufficient permissions' })
      const r = getRepos()

      const existing = await r.maintenanceRequests.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Maintenance request not found' })
      if ((existing as any).state !== 'in_progress')
        return status(400, { message: 'Only in-progress requests can be completed' })

      if (body.duration !== undefined && body.duration < 0)
        return status(400, { message: 'Duration cannot be negative' })

      const updates: any = {
        state: 'done',
        completedDate: new Date(),
      }
      if (body.duration !== undefined) updates.duration = body.duration
      if (body.notes) updates.notes = body.notes

      const request = await r.maintenanceRequests.update(id, updates)

      // If recurring, schedule next maintenance
      if ((existing as any).isRecurring && (existing as any).recurringDays) {
        const nextDate = new Date((existing as any).scheduledDate)
        nextDate.setDate(nextDate.getDate() + (existing as any).recurringDays)
        await r.maintenanceRequests.create({
          orgId,
          name: (existing as any).name,
          equipmentId: (existing as any).equipmentId,
          type: (existing as any).type,
          priority: (existing as any).priority,
          assigneeId: (existing as any).assigneeId,
          scheduledDate: nextDate,
          description: (existing as any).description,
          isRecurring: true,
          recurringDays: (existing as any).recurringDays,
          state: 'new',
          createdBy: user.id,
        } as any)
      }

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'maintenance_request', entityId: id, entityName: (request as any).name, changes: [{ field: 'state', before: 'in_progress', after: 'done' }] })

      return { maintenanceRequest: request }
    },
    {
      isSignIn: true,
      body: t.Object({
        duration: t.Optional(t.Number({ minimum: 0 })),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('maintenance.manage') && !['admin'].includes(user.role))
      return status(403, { message: 'Insufficient permissions' })
    const r = getRepos()

    const existing = await r.maintenanceRequests.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Maintenance request not found' })
    if ((existing as any).state === 'done')
      return status(400, { message: 'Cannot cancel a completed request' })

    const request = await r.maintenanceRequests.update(id, { state: 'cancelled' } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'maintenance_request', entityId: id, entityName: (request as any).name, changes: [{ field: 'state', before: (existing as any).state, after: 'cancelled' }] })

    return { maintenanceRequest: request }
  }, { isSignIn: true })
