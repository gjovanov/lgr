import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { reachMilestone } from 'services/biz/project.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const milestoneController = new Elysia({ prefix: '/org/:orgId/project/milestones' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.read')) {
      return status(403, { message: 'Forbidden: project.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.projectId) filter.projectId = query.projectId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 50
    const result = await r.projectMilestones.findAll(filter, { page, size, sort: { deadline: 1 } })

    return {
      milestones: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.write')) {
      return status(403, { message: 'Forbidden: project.write permission required' })
    }
    const r = getRepos()

    // Verify project exists
    const project = await r.projects.findOne({ id: body.projectId, orgId } as any)
    if (!project) return status(404, { message: 'Project not found' })

    const milestone = await r.projectMilestones.create({
      orgId,
      projectId: body.projectId,
      name: body.name,
      deadline: new Date(body.deadline),
      isReached: false,
      salesOrderLineIndex: body.salesOrderLineIndex,
    } as any)

    createAuditEntry(r, {
      orgId, userId: user.id, action: 'create', entityType: 'ProjectMilestone',
      entityId: milestone.id, entityName: body.name, newValues: milestone,
    }).catch(() => {})

    return milestone
  }, {
    isSignIn: true,
    body: t.Object({
      projectId: t.String(),
      name: t.String({ minLength: 1 }),
      deadline: t.String(),
      salesOrderLineIndex: t.Optional(t.Number({ minimum: 0 })),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.write')) {
      return status(403, { message: 'Forbidden: project.write permission required' })
    }
    const r = getRepos()

    const existing = await r.projectMilestones.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Milestone not found' })

    const updates: any = { ...body }
    if (body.deadline) updates.deadline = new Date(body.deadline)

    const updated = await r.projectMilestones.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry(r, {
        orgId, userId: user.id, action: 'update', entityType: 'ProjectMilestone',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      deadline: t.Optional(t.String()),
      salesOrderLineIndex: t.Optional(t.Number({ minimum: 0 })),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.write')) {
      return status(403, { message: 'Forbidden: project.write permission required' })
    }
    const r = getRepos()
    const existing = await r.projectMilestones.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Milestone not found' })

    await r.projectMilestones.delete(id)

    createAuditEntry(r, {
      orgId, userId: user.id, action: 'delete', entityType: 'ProjectMilestone',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { isSignIn: true })

  // ── REACH MILESTONE ──
  .post('/:id/reach', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.write')) {
      return status(403, { message: 'Forbidden: project.write permission required' })
    }
    const r = getRepos()
    const existing = await r.projectMilestones.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Milestone not found' })

    try {
      await reachMilestone(id, orgId)
    } catch (err: any) {
      return status(400, { message: err.message })
    }

    createAuditEntry(r, {
      orgId, userId: user.id, action: 'update', entityType: 'ProjectMilestone',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'isReached', oldValue: false, newValue: true }],
    }).catch(() => {})

    const updated = await r.projectMilestones.findById(id)
    return updated
  }, { isSignIn: true })
