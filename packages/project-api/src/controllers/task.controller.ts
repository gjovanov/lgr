import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'state', 'priority', 'dateDeadline', 'stageName']

const VALID_TASK_STATES = ['open', 'in_progress', 'done', 'cancelled'] as const

const TASK_TRANSITIONS: Record<string, string[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled', 'open'],
  done: ['open'],
  cancelled: ['open'],
}

export const taskController = new Elysia({ prefix: '/org/:orgId/project/tasks' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    if (!query.projectId) {
      return status(400, { message: 'projectId query parameter is required' })
    }

    const filter: Record<string, any> = { orgId, projectId: query.projectId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'description']))
    }
    if (query.state) filter.state = query.state
    if (query.stageName) filter.stageName = query.stageName
    if (query.priority) filter.priority = query.priority
    if (query.milestoneId) filter.milestoneId = query.milestoneId
    if (query.assigneeIds) {
      const ids = Array.isArray(query.assigneeIds) ? query.assigneeIds : (query.assigneeIds as string).split(',')
      filter.assigneeIds = { $in: ids }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.projectTasks.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      tasks: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'project.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const task = await r.projectTasks.findOne({ id, orgId } as any)
    if (!task) return status(404, { message: 'Task not found' })
    return task
  }, { access: { permission: 'project.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    // Verify project exists
    const project = await r.projects.findOne({ id: body.projectId, orgId } as any)
    if (!project) return status(404, { message: 'Project not found' })

    const task = await r.projectTasks.create({
      orgId,
      projectId: body.projectId,
      name: body.name,
      description: body.description,
      stageName: body.stageName || (project.stages?.[0]?.name || 'New'),
      state: 'in_progress',
      priority: body.priority || 'normal',
      assigneeIds: body.assigneeIds || [],
      parentTaskId: body.parentTaskId,
      dependencyIds: body.dependencyIds || [],
      dateDeadline: body.dateDeadline ? new Date(body.dateDeadline) : undefined,
      dateStart: body.dateStart ? new Date(body.dateStart) : undefined,
      dateEnd: body.dateEnd ? new Date(body.dateEnd) : undefined,
      plannedHours: body.plannedHours || 0,
      effectiveHours: 0,
      remainingHours: body.plannedHours || 0,
      milestoneId: body.milestoneId,
      tags: body.tags,
      isRecurring: body.isRecurring || false,
      recurringInterval: body.recurringInterval,
      recurringPeriod: body.recurringPeriod,
      createdBy: user.id,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'create', entityType: 'ProjectTask',
      entityId: task.id, entityName: body.name,
    }).catch(() => {})

    return task
  }, {
    access: { permission: 'project.write' },
    body: t.Object({
      projectId: t.String(),
      name: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      stageName: t.Optional(t.String()),
      priority: t.Optional(t.String()),
      assigneeIds: t.Optional(t.Array(t.String())),
      parentTaskId: t.Optional(t.String()),
      dependencyIds: t.Optional(t.Array(t.String())),
      dateDeadline: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      plannedHours: t.Optional(t.Number({ minimum: 0 })),
      milestoneId: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      isRecurring: t.Optional(t.Boolean()),
      recurringInterval: t.Optional(t.Number({ minimum: 1 })),
      recurringPeriod: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.projectTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Task not found' })

    const updates: any = { ...body }
    if (body.dateDeadline) updates.dateDeadline = new Date(body.dateDeadline)
    if (body.dateStart) updates.dateStart = new Date(body.dateStart)
    if (body.dateEnd) updates.dateEnd = new Date(body.dateEnd)

    const updated = await r.projectTasks.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'project', action: 'update', entityType: 'ProjectTask',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    access: { permission: 'project.write' },
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      description: t.Optional(t.String()),
      stageName: t.Optional(t.String()),
      priority: t.Optional(t.String()),
      assigneeIds: t.Optional(t.Array(t.String())),
      parentTaskId: t.Optional(t.String()),
      dependencyIds: t.Optional(t.Array(t.String())),
      dateDeadline: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      plannedHours: t.Optional(t.Number({ minimum: 0 })),
      milestoneId: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      isRecurring: t.Optional(t.Boolean()),
      recurringInterval: t.Optional(t.Number({ minimum: 1 })),
      recurringPeriod: t.Optional(t.String()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.projectTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Task not found' })

    await r.projectTasks.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'delete', entityType: 'ProjectTask',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { access: { permission: 'project.write' } })

  // ── TRANSITION STATE ──
  .post('/:id/transition', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.projectTasks.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Task not found' })

    // Validate target state
    if (!(VALID_TASK_STATES as readonly string[]).includes(body.state)) {
      return status(400, { message: `Invalid task state "${body.state}". Valid states: ${VALID_TASK_STATES.join(', ')}` })
    }

    // Validate transition is allowed
    const allowedStates = TASK_TRANSITIONS[existing.state] || []
    if (!allowedStates.includes(body.state)) {
      return status(400, { message: `Cannot transition task from "${existing.state}" to "${body.state}"` })
    }

    const oldState = existing.state
    const updates: any = { state: body.state }

    // If transitioning to done, set dateEnd
    if (body.state === 'done' && !existing.dateEnd) {
      updates.dateEnd = new Date()
    }
    // If transitioning to cancelled, set dateEnd
    if (body.state === 'cancelled' && !existing.dateEnd) {
      updates.dateEnd = new Date()
    }

    const updated = await r.projectTasks.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to transition' })

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'update', entityType: 'ProjectTask',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'state', oldValue: oldState, newValue: body.state }],
    }).catch(() => {})

    return updated
  }, {
    access: { permission: 'project.write' },
    body: t.Object({
      state: t.String(),
    }),
  })
