import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { syncTaskHours } from 'services/biz/project.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

const ALLOWED_SORT_FIELDS = ['createdAt', 'date', 'hours', 'employeeId']

export const timesheetController = new Elysia({ prefix: '/org/:orgId/project/timesheets' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.projectId) filter.projectId = query.projectId
    if (query.taskId) filter.taskId = query.taskId
    if (query.employeeId) filter.employeeId = query.employeeId
    if (query.startDate || query.endDate) {
      filter.date = {}
      if (query.startDate) filter.date.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.date.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'date'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.projectTimesheets.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      timesheets: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'project.timesheet' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    // Verify project exists
    const project = await r.projects.findOne({ id: body.projectId, orgId } as any)
    if (!project) return status(404, { message: 'Project not found' })

    // Verify task exists if provided
    if (body.taskId) {
      const task = await r.projectTasks.findOne({ id: body.taskId, orgId } as any)
      if (!task) return status(404, { message: 'Task not found' })
    }

    const entry = await r.projectTimesheets.create({
      orgId,
      employeeId: body.employeeId,
      projectId: body.projectId,
      taskId: body.taskId,
      date: new Date(body.date),
      hours: body.hours,
      description: body.description,
      unitAmount: body.unitAmount || 0,
    } as any)

    // Auto-sync task hours if taskId provided
    if (body.taskId) {
      syncTaskHours(body.taskId, orgId).catch(() => {})
    }

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'create', entityType: 'ProjectTimesheet',
      entityId: entry.id, entityName: `${body.hours}h on ${body.date}`,
    }).catch(() => {})

    return entry
  }, {
    access: { permission: 'project.timesheet' },
    body: t.Object({
      employeeId: t.String(),
      projectId: t.String(),
      taskId: t.Optional(t.String()),
      date: t.String(),
      hours: t.Number({ minimum: 0.01 }),
      description: t.Optional(t.String()),
      unitAmount: t.Optional(t.Number({ minimum: 0 })),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.projectTimesheets.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Timesheet entry not found' })

    const updates: any = { ...body }
    if (body.date) updates.date = new Date(body.date)

    const updated = await r.projectTimesheets.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    // Sync task hours for both old and new task
    const taskIdsToSync = new Set<string>()
    if (existing.taskId) taskIdsToSync.add(existing.taskId)
    if (updated.taskId) taskIdsToSync.add(updated.taskId)
    for (const taskId of taskIdsToSync) {
      syncTaskHours(taskId, orgId).catch(() => {})
    }

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'project', action: 'update', entityType: 'ProjectTimesheet',
        entityId: id, entityName: `${updated.hours}h on ${updated.date}`, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    access: { permission: 'project.timesheet' },
    body: t.Object({
      employeeId: t.Optional(t.String()),
      projectId: t.Optional(t.String()),
      taskId: t.Optional(t.String()),
      date: t.Optional(t.String()),
      hours: t.Optional(t.Number({ minimum: 0.01 })),
      description: t.Optional(t.String()),
      unitAmount: t.Optional(t.Number({ minimum: 0 })),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const existing = await r.projectTimesheets.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Timesheet entry not found' })

    await r.projectTimesheets.delete(id)

    // Sync task hours after deletion
    if (existing.taskId) {
      syncTaskHours(existing.taskId, orgId).catch(() => {})
    }

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'delete', entityType: 'ProjectTimesheet',
      entityId: id, entityName: `${existing.hours}h on ${existing.date}`,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { access: { permission: 'project.timesheet' } })
