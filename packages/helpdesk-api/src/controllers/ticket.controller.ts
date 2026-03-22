import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { eventBus } from 'services/events/event-bus'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'state', 'priority', 'slaDeadline', 'stageName']

/**
 * Auto-apply SLA policy based on team and priority.
 */
async function applySLA(orgId: string, teamId?: string, priority?: string): Promise<{ slaDeadline?: Date; slaStatus: string }> {
  const r = getRepos()
  const filter: Record<string, any> = { orgId, isActive: true }
  if (teamId) filter.teamId = teamId
  if (priority) filter.priority = priority

  const policies = await r.slaPolicies.findMany(filter as any)
  if (!policies.length) {
    // Try without team
    if (teamId) {
      const fallback = await r.slaPolicies.findMany({ orgId, isActive: true, priority } as any)
      if (fallback.length) {
        const policy = fallback[0]
        const hours = policy.targets?.resolutionHours || 24
        const slaDeadline = new Date(Date.now() + hours * 3600 * 1000)
        return { slaDeadline, slaStatus: 'on_track' }
      }
    }
    return { slaStatus: 'none' }
  }

  const policy = policies[0]
  const hours = policy.targets?.resolutionHours || 24
  const slaDeadline = new Date(Date.now() + hours * 3600 * 1000)
  return { slaDeadline, slaStatus: 'on_track' }
}

/**
 * Auto-assign ticket to a team member via round-robin.
 */
async function autoAssign(orgId: string, teamId: string): Promise<string | undefined> {
  const r = getRepos()
  const team = await r.helpdeskTeams.findOne({ id: teamId, orgId } as any)
  if (!team || !team.memberIds?.length) return undefined

  if (team.assignmentMethod === 'round_robin') {
    // Simple round-robin: count tickets per member, assign to least loaded
    const counts = new Map<string, number>()
    for (const memberId of team.memberIds) {
      const memberTickets = await r.tickets.findMany({
        orgId,
        assigneeId: memberId,
        state: { $nin: ['resolved', 'closed'] },
      } as any)
      counts.set(memberId, memberTickets.length)
    }
    let minCount = Infinity
    let assigneeId: string | undefined
    for (const [memberId, count] of counts) {
      if (count < minCount) {
        minCount = count
        assigneeId = memberId
      }
    }
    return assigneeId
  }

  // Default: assign to team leader
  return team.leaderId
}

/**
 * Transition ticket state with validation.
 */
function validateTransition(currentState: string, newState: string): boolean {
  const transitions: Record<string, string[]> = {
    new: ['in_progress', 'closed'],
    in_progress: ['resolved', 'on_hold', 'closed'],
    on_hold: ['in_progress', 'closed'],
    resolved: ['in_progress', 'closed'],
    closed: ['in_progress'],
  }
  return transitions[currentState]?.includes(newState) ?? false
}

export const ticketController = new Elysia({ prefix: '/org/:orgId/helpdesk/tickets' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'description']))
    }
    if (query.state) filter.state = query.state
    if (query.priority) filter.priority = query.priority
    if (query.assigneeId) filter.assigneeId = query.assigneeId
    if (query.teamId) filter.teamId = query.teamId
    if (query.partnerId) filter.partnerId = query.partnerId
    if (query.slaStatus) filter.slaStatus = query.slaStatus
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.tickets.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Batch lookup partners and assignees
    const contactIds = new Set<string>()
    const userIds = new Set<string>()
    for (const item of result.items) {
      if (item.partnerId) contactIds.add(item.partnerId)
      if (item.assigneeId) userIds.add(item.assigneeId)
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
      tickets: result.items.map((ticket: any) => ({
        ...ticket,
        partner: contactMap.get(ticket.partnerId) || null,
        assignee: userMap.get(ticket.assigneeId) || null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'helpdesk.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const ticket = await r.tickets.findOne({ id, orgId } as any)
    if (!ticket) return status(404, { message: 'Ticket not found' })

    const partner = ticket.partnerId ? await r.contacts.findById(ticket.partnerId) : null
    const assignee = ticket.assigneeId ? await r.users.findById(ticket.assigneeId) : null

    return { ...ticket, partner, assignee }
  }, { access: { permission: 'helpdesk.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const name = await getNextNumber(orgId, 'TKT')

    // Auto-apply SLA
    const sla = await applySLA(orgId, body.teamId, body.priority || 'normal')

    // Auto-assign if team is set and no assignee provided
    let assigneeId = body.assigneeId
    if (!assigneeId && body.teamId) {
      assigneeId = await autoAssign(orgId, body.teamId)
    }

    const ticket = await r.tickets.create({
      orgId,
      name,
      description: body.description,
      channelSource: body.channelSource || 'web',
      partnerId: body.partnerId,
      assigneeId,
      teamId: body.teamId,
      stageName: body.stageName || 'New',
      state: 'new',
      priority: body.priority || 'normal',
      slaDeadline: sla.slaDeadline,
      slaStatus: sla.slaStatus,
      tags: body.tags,
      categoryId: body.categoryId,
      totalHours: 0,
      relatedEntityType: body.relatedEntityType,
      relatedEntityId: body.relatedEntityId,
      createdBy: user.id,
    } as any)

    await upsertTags(orgId, 'ticket', body.tags)

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'create', entityType: 'Ticket',
      entityId: ticket.id, entityName: name,
    }).catch(() => {})

    eventBus.emit('ticket.created', {
      ticketId: ticket.id, orgId, name,
      assigneeId: ticket.assigneeId, teamId: body.teamId,
      partnerId: body.partnerId, channelSource: body.channelSource || 'manual',
    })

    return ticket
  }, {
    access: { permission: 'helpdesk.write' },
    body: t.Object({
      description: t.String({ minLength: 1 }),
      channelSource: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
      assigneeId: t.Optional(t.String()),
      teamId: t.Optional(t.String()),
      stageName: t.Optional(t.String()),
      priority: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      categoryId: t.Optional(t.String()),
      relatedEntityType: t.Optional(t.String()),
      relatedEntityId: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.tickets.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Ticket not found' })

    const updates: any = { ...body }

    const updated = await r.tickets.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    if (body.tags) await upsertTags(orgId, 'ticket', body.tags)

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'Ticket',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    access: { permission: 'helpdesk.write' },
    body: t.Object({
      description: t.Optional(t.String()),
      channelSource: t.Optional(t.String()),
      partnerId: t.Optional(t.String()),
      assigneeId: t.Optional(t.String()),
      teamId: t.Optional(t.String()),
      stageName: t.Optional(t.String()),
      priority: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      categoryId: t.Optional(t.String()),
      relatedEntityType: t.Optional(t.String()),
      relatedEntityId: t.Optional(t.String()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.tickets.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Ticket not found' })

    if (!['new', 'closed'].includes(existing.state)) {
      return status(400, { message: 'Can only delete new or closed tickets' })
    }

    await r.tickets.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'delete', entityType: 'Ticket',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { access: { permission: 'helpdesk.manage' } })

  // ── TRANSITION STATE ──
  .post('/:id/transition', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.tickets.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Ticket not found' })

    if (!validateTransition(existing.state, body.state)) {
      return status(400, { message: `Invalid transition from '${existing.state}' to '${body.state}'` })
    }

    const oldState = existing.state
    const updates: any = { state: body.state }

    // Track first response
    if (body.state === 'in_progress' && !existing.firstResponseDate) {
      updates.firstResponseDate = new Date()
    }
    // Track resolution
    if (body.state === 'resolved') {
      updates.resolutionDate = new Date()
      // Check SLA status
      if (existing.slaDeadline && new Date() > new Date(existing.slaDeadline)) {
        updates.slaStatus = 'breached'
      } else if (existing.slaDeadline) {
        updates.slaStatus = 'met'
      }
    }
    // Track closure
    if (body.state === 'closed') {
      updates.closedDate = new Date()
    }

    const updated = await r.tickets.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to transition' })

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'Ticket',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'state', oldValue: oldState, newValue: body.state }],
    }).catch(() => {})

    return updated
  }, {
    access: { permission: 'helpdesk.write' },
    body: t.Object({
      state: t.String(),
    }),
  })

  // ── ASSIGN ──
  .post('/:id/assign', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.tickets.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Ticket not found' })

    const oldAssigneeId = existing.assigneeId
    const updated = await r.tickets.update(id, { assigneeId: body.assigneeId } as any)
    if (!updated) return status(500, { message: 'Failed to assign' })

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'Ticket',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'assigneeId', oldValue: oldAssigneeId, newValue: body.assigneeId }],
    }).catch(() => {})

    return updated
  }, {
    access: { permission: 'helpdesk.write' },
    body: t.Object({
      assigneeId: t.String(),
    }),
  })

  // ── RATE ──
  .post('/:id/rate', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.tickets.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Ticket not found' })

    const updated = await r.tickets.update(id, {
      rating: body.rating,
      ratingComment: body.comment,
    } as any)
    if (!updated) return status(500, { message: 'Failed to rate' })

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'Ticket',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'rating', oldValue: existing.rating, newValue: body.rating }],
    }).catch(() => {})

    return updated
  }, {
    access: { permission: 'helpdesk.read' },
    body: t.Object({
      rating: t.Number({ minimum: 1, maximum: 5 }),
      comment: t.Optional(t.String()),
    }),
  })
