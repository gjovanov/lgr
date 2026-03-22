import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'state', 'priority', 'dateScheduled', 'dateStart', 'dateEnd']

export const fieldServiceController = new Elysia({ prefix: '/org/:orgId/project/field-service' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.read')) {
      return status(403, { message: 'Forbidden: field_service.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'description', 'location']))
    }
    if (query.assigneeId) filter.assigneeId = query.assigneeId
    if (query.partnerId) filter.partnerId = query.partnerId
    if (query.projectId) filter.projectId = query.projectId
    if (query.state) filter.state = query.state
    if (query.priority) filter.priority = query.priority
    if (query.startDate || query.endDate) {
      filter.dateScheduled = {}
      if (query.startDate) filter.dateScheduled.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.dateScheduled.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.fieldServiceTasks.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Batch lookup partners and assignees
    const contactIds = new Set<string>()
    const userIds = new Set<string>()
    for (const item of result.items) {
      if (item.partnerId) contactIds.add(item.partnerId as any)
      if (item.assigneeId) userIds.add(item.assigneeId as any)
    }
    const contacts = contactIds.size > 0
      ? await r.contacts.findMany({ id: { $in: [...contactIds] } } as any)
      : []
    const contactMap = new Map(contacts.map((c: any) => [c.id, c]))

    const users = userIds.size > 0
      ? await r.users.findMany({ id: { $in: [...userIds] } } as any)
      : []
    const userMap = new Map(users.map((u: any) => [u.id, u]))

    return {
      tasks: result.items.map((task: any) => ({
        ...task,
        partner: contactMap.get(task.partnerId) || null,
        assignee: userMap.get(task.assigneeId) || null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.read')) {
      return status(403, { message: 'Forbidden: field_service.read permission required' })
    }
    const r = getRepos()
    const task = await r.fieldServiceTasks.findOne({ id, orgId } as any)
    if (!task) return status(404, { message: 'Field service task not found' })

    const partner = task.partnerId ? await r.contacts.findById(task.partnerId as any) : null
    const assignee = task.assigneeId ? await r.users.findById(task.assigneeId as any) : null

    return { ...task, partner, assignee }
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.write')) {
      return status(403, { message: 'Forbidden: field_service.write permission required' })
    }
    const r = getRepos()

    const task = await r.fieldServiceTasks.create({
      orgId,
      name: body.name,
      description: body.description,
      partnerId: body.partnerId,
      assigneeId: body.assigneeId,
      projectId: body.projectId,
      state: 'scheduled',
      priority: body.priority || 'normal',
      dateScheduled: new Date(body.dateScheduled),
      location: body.location,
      latitude: body.latitude,
      longitude: body.longitude,
      plannedHours: body.plannedHours || 0,
      effectiveHours: 0,
      parts: body.parts || [],
      totalPartsCost: 0,
      totalLaborCost: 0,
      tags: body.tags,
      createdBy: user.id,
    } as any)

    await upsertTags(orgId, 'field_service', body.tags)

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'create', entityType: 'FieldServiceTask',
      entityId: task.id, entityName: body.name,
    }).catch(() => {})

    return task
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
      assigneeId: t.String(),
      projectId: t.Optional(t.String()),
      priority: t.Optional(t.String()),
      dateScheduled: t.String(),
      location: t.Optional(t.String()),
      latitude: t.Optional(t.Number()),
      longitude: t.Optional(t.Number()),
      plannedHours: t.Optional(t.Number({ minimum: 0 })),
      parts: t.Optional(t.Array(t.Object({
        productId: t.String(),
        quantity: t.Number({ minimum: 0 }),
        unitCost: t.Optional(t.Number({ minimum: 0 })),
      }))),
      tags: t.Optional(t.Array(t.String())),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.write')) {
      return status(403, { message: 'Forbidden: field_service.write permission required' })
    }
    const r = getRepos()

    const existing = await r.fieldServiceTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Field service task not found' })

    const updates: any = { ...body }
    if (body.dateScheduled) updates.dateScheduled = new Date(body.dateScheduled)

    const updated = await r.fieldServiceTasks.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    if (body.tags) await upsertTags(orgId, 'field_service', body.tags)

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'project', action: 'update', entityType: 'FieldServiceTask',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      description: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
      assigneeId: t.Optional(t.String()),
      projectId: t.Optional(t.String()),
      priority: t.Optional(t.String()),
      dateScheduled: t.Optional(t.String()),
      location: t.Optional(t.String()),
      latitude: t.Optional(t.Number()),
      longitude: t.Optional(t.Number()),
      plannedHours: t.Optional(t.Number({ minimum: 0 })),
      parts: t.Optional(t.Array(t.Object({
        productId: t.String(),
        quantity: t.Number({ minimum: 0 }),
        unitCost: t.Optional(t.Number({ minimum: 0 })),
      }))),
      tags: t.Optional(t.Array(t.String())),
      worksheetNotes: t.Optional(t.String()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.manage')) {
      return status(403, { message: 'Forbidden: field_service.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.fieldServiceTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Field service task not found' })

    if (existing.state !== 'scheduled') {
      return status(400, { message: 'Can only delete tasks in scheduled state' })
    }

    await r.fieldServiceTasks.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'delete', entityType: 'FieldServiceTask',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { isSignIn: true })

  // ── START ──
  .post('/:id/start', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.write')) {
      return status(403, { message: 'Forbidden: field_service.write permission required' })
    }
    const r = getRepos()
    const existing = await r.fieldServiceTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Field service task not found' })

    if (existing.state !== 'scheduled') {
      return status(400, { message: `Cannot start task in '${existing.state}' state. Only scheduled tasks can be started.` })
    }

    const updated = await r.fieldServiceTasks.update(id, {
      state: 'in_progress',
      dateStart: new Date(),
    } as any)
    if (!updated) return status(500, { message: 'Failed to start task' })

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'update', entityType: 'FieldServiceTask',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'state', oldValue: 'scheduled', newValue: 'in_progress' }],
    }).catch(() => {})

    return updated
  }, { isSignIn: true })

  // ── COMPLETE ──
  .post('/:id/complete', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.write')) {
      return status(403, { message: 'Forbidden: field_service.write permission required' })
    }
    const r = getRepos()
    const existing = await r.fieldServiceTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Field service task not found' })

    if (existing.state !== 'in_progress') {
      return status(400, { message: `Cannot complete task in '${existing.state}' state. Only in-progress tasks can be completed.` })
    }

    const effectiveHours = body.effectiveHours ?? existing.effectiveHours ?? 0
    const laborRate = body.laborRate ?? 0

    // Compute parts cost from parts array
    const parts = existing.parts || []
    const totalPartsCost = parts.reduce((sum: number, p: any) => sum + (p.quantity * (p.unitCost || 0)), 0)

    // Compute labor cost
    const totalLaborCost = effectiveHours * laborRate

    const updates: any = {
      state: 'done',
      dateEnd: new Date(),
      effectiveHours,
      totalPartsCost,
      totalLaborCost,
    }

    if (body.worksheetNotes) updates.worksheetNotes = body.worksheetNotes
    if (body.customerSignature) updates.customerSignature = body.customerSignature
    if (body.technicianSignature) updates.technicianSignature = body.technicianSignature

    const updated = await r.fieldServiceTasks.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to complete task' })

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'update', entityType: 'FieldServiceTask',
      entityId: id, entityName: existing.name,
      changes: [
        { field: 'state', oldValue: 'in_progress', newValue: 'done' },
        { field: 'effectiveHours', oldValue: existing.effectiveHours, newValue: effectiveHours },
        { field: 'totalPartsCost', oldValue: existing.totalPartsCost, newValue: totalPartsCost },
        { field: 'totalLaborCost', oldValue: existing.totalLaborCost, newValue: totalLaborCost },
      ],
    }).catch(() => {})

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      effectiveHours: t.Optional(t.Number({ minimum: 0 })),
      laborRate: t.Optional(t.Number({ minimum: 0 })),
      worksheetNotes: t.Optional(t.String()),
      customerSignature: t.Optional(t.String()),
      technicianSignature: t.Optional(t.String()),
    }),
  })

  // ── CANCEL ──
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('field_service.write')) {
      return status(403, { message: 'Forbidden: field_service.write permission required' })
    }
    const r = getRepos()
    const existing = await r.fieldServiceTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Field service task not found' })

    if (existing.state === 'done' || existing.state === 'cancelled') {
      return status(400, { message: `Cannot cancel task in '${existing.state}' state` })
    }

    const oldState = existing.state
    const updated = await r.fieldServiceTasks.update(id, { state: 'cancelled' } as any)
    if (!updated) return status(500, { message: 'Failed to cancel task' })

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'update', entityType: 'FieldServiceTask',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'state', oldValue: oldState, newValue: 'cancelled' }],
    }).catch(() => {})

    return updated
  }, { isSignIn: true })
