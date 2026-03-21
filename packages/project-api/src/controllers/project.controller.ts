import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { getProjectProfitability } from 'services/biz/project.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'state', 'dateStart', 'dateEnd', 'budgetPlanned']

async function upsertTags(orgId: string, tags?: string[]) {
  if (!tags?.length) return
  const r = getRepos()
  const existing = await r.tags.findMany({ orgId, type: 'project', value: { $in: tags } } as any)
  const existingValues = new Set(existing.map((t: any) => t.value))
  const newTags = tags.filter(v => !existingValues.has(v))
  for (const value of newTags) {
    await r.tags.create({ orgId, type: 'project', value } as any)
  }
}

export const projectController = new Elysia({ prefix: '/org/:orgId/project/projects' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.read')) {
      return status(403, { message: 'Forbidden: project.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'description']))
    }
    if (query.state) filter.state = query.state
    if (query.managerId) filter.managerId = query.managerId
    if (query.partnerId) filter.partnerId = query.partnerId
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }
    if (query.startDate || query.endDate) {
      filter.dateStart = {}
      if (query.startDate) filter.dateStart.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.dateStart.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.projects.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Batch lookup partners and managers
    const contactIds = new Set<string>()
    const userIds = new Set<string>()
    for (const item of result.items) {
      if (item.partnerId) contactIds.add(item.partnerId)
      if (item.managerId) userIds.add(item.managerId)
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
      projects: result.items.map((p: any) => ({
        ...p,
        partner: contactMap.get(p.partnerId) || null,
        manager: userMap.get(p.managerId) || null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.read')) {
      return status(403, { message: 'Forbidden: project.read permission required' })
    }
    const r = getRepos()
    const project = await r.projects.findOne({ id, orgId } as any)
    if (!project) return status(404, { message: 'Project not found' })

    const partner = project.partnerId ? await r.contacts.findById(project.partnerId) : null
    const manager = project.managerId ? await r.users.findById(project.managerId) : null

    return { ...project, partner, manager }
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.write')) {
      return status(403, { message: 'Forbidden: project.write permission required' })
    }
    const r = getRepos()

    const project = await r.projects.create({
      orgId,
      name: body.name,
      description: body.description,
      partnerId: body.partnerId,
      state: 'in_progress',
      dateStart: body.dateStart ? new Date(body.dateStart) : undefined,
      dateEnd: body.dateEnd ? new Date(body.dateEnd) : undefined,
      managerId: body.managerId,
      memberIds: body.memberIds || [],
      stages: body.stages || [
        { name: 'New', sequence: 1, fold: false },
        { name: 'In Progress', sequence: 2, fold: false },
        { name: 'Done', sequence: 3, fold: true },
      ],
      color: body.color,
      tags: body.tags,
      budgetPlanned: body.budgetPlanned || 0,
      budgetSpent: 0,
      revenueExpected: body.revenueExpected || 0,
      revenueInvoiced: 0,
      isFavorite: false,
      salesOrderId: body.salesOrderId,
      createdBy: user.id,
    } as any)

    await upsertTags(orgId, body.tags)

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'create', entityType: 'Project',
      entityId: project.id, entityName: body.name,
    }).catch(() => {})

    return project
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      managerId: t.String(),
      memberIds: t.Optional(t.Array(t.String())),
      stages: t.Optional(t.Array(t.Object({
        name: t.String(),
        sequence: t.Number(),
        fold: t.Optional(t.Boolean()),
      }))),
      color: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      budgetPlanned: t.Optional(t.Number({ minimum: 0 })),
      revenueExpected: t.Optional(t.Number({ minimum: 0 })),
      salesOrderId: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.write')) {
      return status(403, { message: 'Forbidden: project.write permission required' })
    }
    const r = getRepos()

    const existing = await r.projects.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Project not found' })

    const updates: any = { ...body }
    if (body.dateStart) updates.dateStart = new Date(body.dateStart)
    if (body.dateEnd) updates.dateEnd = new Date(body.dateEnd)

    const updated = await r.projects.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    if (body.tags) await upsertTags(orgId, body.tags)

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'project', action: 'update', entityType: 'Project',
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
      state: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      managerId: t.Optional(t.String()),
      memberIds: t.Optional(t.Array(t.String())),
      stages: t.Optional(t.Array(t.Object({
        name: t.String(),
        sequence: t.Number(),
        fold: t.Optional(t.Boolean()),
      }))),
      color: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      budgetPlanned: t.Optional(t.Number({ minimum: 0 })),
      revenueExpected: t.Optional(t.Number({ minimum: 0 })),
      salesOrderId: t.Optional(t.String()),
      isFavorite: t.Optional(t.Boolean()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.write')) {
      return status(403, { message: 'Forbidden: project.write permission required' })
    }
    const r = getRepos()
    const existing = await r.projects.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Project not found' })

    // Check for existing tasks
    const tasks = await r.projectTasks.findMany({ orgId, projectId: id } as any)
    if (tasks.length > 0) {
      return status(400, { message: 'Cannot delete project with existing tasks. Remove all tasks first.' })
    }

    await r.projects.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'project', action: 'delete', entityType: 'Project',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { isSignIn: true })

  // ── PROFITABILITY ──
  .get('/:id/profitability', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('project.read')) {
      return status(403, { message: 'Forbidden: project.read permission required' })
    }
    try {
      return await getProjectProfitability(id, orgId)
    } catch (err: any) {
      return status(404, { message: err.message || 'Project not found' })
    }
  }, { isSignIn: true })
