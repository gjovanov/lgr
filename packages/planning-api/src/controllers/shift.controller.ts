import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

const ALLOWED_SORT_FIELDS = ['createdAt', 'dateStart', 'dateEnd', 'state', 'hours']

export const shiftController = new Elysia({ prefix: '/org/:orgId/planning/shifts' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.state) filter.state = query.state
    if (query.employeeId) filter.employeeId = query.employeeId
    if (query.projectId) filter.projectId = query.projectId
    if (query.startDate || query.endDate) {
      filter.dateStart = {}
      if (query.startDate) filter.dateStart.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.dateStart.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'dateStart'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.shifts.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      shifts: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'planning.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const shift = await r.shifts.findOne({ id, orgId } as any)
    if (!shift) return status(404, { message: 'Shift not found' })
    return shift
  }, { access: { permission: 'planning.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const shift = await r.shifts.create({
      orgId,
      employeeId: body.employeeId,
      roleId: body.roleId,
      projectId: body.projectId,
      taskId: body.taskId,
      dateStart: new Date(body.dateStart),
      dateEnd: new Date(body.dateEnd),
      hours: body.hours,
      state: 'draft',
      isRecurring: body.isRecurring || false,
      recurringTemplateId: body.recurringTemplateId,
      notes: body.notes,
      color: body.color,
      createdBy: user.id,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, action: 'create', module: 'planning',
      entityType: 'Shift', entityId: shift.id,
    })

    return shift
  }, {
    access: { permission: 'planning.write' },
    body: t.Object({
      employeeId: t.Optional(t.String()),
      roleId: t.Optional(t.String()),
      projectId: t.Optional(t.String()),
      taskId: t.Optional(t.String()),
      dateStart: t.String(),
      dateEnd: t.String(),
      hours: t.Number({ minimum: 0 }),
      isRecurring: t.Optional(t.Boolean()),
      recurringTemplateId: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      color: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.shifts.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Shift not found' })

    const updates: any = { ...body }
    if (body.dateStart) updates.dateStart = new Date(body.dateStart)
    if (body.dateEnd) updates.dateEnd = new Date(body.dateEnd)

    const updated = await r.shifts.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, action: 'update', module: 'planning',
        entityType: 'Shift', entityId: id, changes,
      })
    }

    return updated
  }, {
    access: { permission: 'planning.write' },
    body: t.Object({
      employeeId: t.Optional(t.String()),
      roleId: t.Optional(t.String()),
      projectId: t.Optional(t.String()),
      taskId: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      hours: t.Optional(t.Number({ minimum: 0 })),
      state: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      color: t.Optional(t.String()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.shifts.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Shift not found' })

    await r.shifts.delete(id)

    createAuditEntry({
      orgId, userId: user.id, action: 'delete', module: 'planning',
      entityType: 'Shift', entityId: id,
    })

    return { message: 'Deleted' }
  }, { access: { permission: 'planning.write' } })
