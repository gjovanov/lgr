import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const teamController = new Elysia({ prefix: '/org/:orgId/helpdesk/teams' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.read')) {
      return status(403, { message: 'Forbidden: helpdesk.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name']))
    }
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 50
    const result = await r.helpdeskTeams.findAll(filter, { page, size, sort: { name: 1 } })

    return {
      teams: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.read')) {
      return status(403, { message: 'Forbidden: helpdesk.read permission required' })
    }
    const r = getRepos()
    const team = await r.helpdeskTeams.findOne({ id, orgId } as any)
    if (!team) return status(404, { message: 'Team not found' })
    return team
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.manage')) {
      return status(403, { message: 'Forbidden: helpdesk.manage permission required' })
    }
    const r = getRepos()

    const team = await r.helpdeskTeams.create({
      orgId,
      name: body.name,
      memberIds: body.memberIds || [],
      leaderId: body.leaderId,
      assignmentMethod: body.assignmentMethod || 'round_robin',
      emailAlias: body.emailAlias,
      description: body.description,
      isActive: true,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'create', entityType: 'HelpdeskTeam',
      entityId: team.id, entityName: body.name,
    }).catch(() => {})

    return team
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String({ minLength: 1 }),
      memberIds: t.Optional(t.Array(t.String())),
      leaderId: t.String(),
      assignmentMethod: t.Optional(t.String()),
      emailAlias: t.Optional(t.String()),
      description: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.manage')) {
      return status(403, { message: 'Forbidden: helpdesk.manage permission required' })
    }
    const r = getRepos()

    const existing = await r.helpdeskTeams.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Team not found' })

    const updated = await r.helpdeskTeams.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'HelpdeskTeam',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      memberIds: t.Optional(t.Array(t.String())),
      leaderId: t.Optional(t.String()),
      assignmentMethod: t.Optional(t.String()),
      emailAlias: t.Optional(t.String()),
      description: t.Optional(t.String()),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('helpdesk.manage')) {
      return status(403, { message: 'Forbidden: helpdesk.manage permission required' })
    }
    const r = getRepos()
    const existing = await r.helpdeskTeams.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Team not found' })

    await r.helpdeskTeams.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'delete', entityType: 'HelpdeskTeam',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { isSignIn: true })
