import type { RepositoryRegistry } from 'dal'
import type { ITicket } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { getNextNumber } from './sequence.service.js'

/**
 * Apply SLA policy to a ticket based on priority and team.
 */
export async function applySLA(
  ticketId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<ITicket> {
  const r = repos ?? getRepos()
  const ticket = await r.tickets.findOne({ id: ticketId, orgId } as any)
  if (!ticket) throw new Error('Ticket not found')

  // Find matching SLA policy
  const policies = await r.slaPolicies.findMany({
    orgId,
    priority: ticket.priority,
    isActive: true,
    ...(ticket.teamId ? { $or: [{ teamId: ticket.teamId }, { teamId: { $exists: false } }] } : {}),
  } as any)

  if (policies.length === 0) return ticket

  // Use the most specific policy (team-specific first, then generic)
  const policy = policies.find((p: any) => p.teamId === ticket.teamId) || policies[0]

  let slaDeadline: Date | undefined
  if (policy.targets.resolutionHours) {
    slaDeadline = new Date(ticket.createdAt.getTime() + policy.targets.resolutionHours * 60 * 60 * 1000)
  }

  const updated = await r.tickets.update(ticketId, {
    slaDeadline,
    slaStatus: 'on_track',
  } as any)
  if (!updated) throw new Error('Failed to apply SLA')

  logger.info({ ticketId, policyName: policy.name, slaDeadline }, 'SLA applied to ticket')
  return updated
}

/**
 * Auto-assign a ticket to a team member based on assignment method.
 */
export async function autoAssignTicket(
  ticketId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<ITicket> {
  const r = repos ?? getRepos()
  const ticket = await r.tickets.findOne({ id: ticketId, orgId } as any)
  if (!ticket) throw new Error('Ticket not found')
  if (!ticket.teamId) throw new Error('Ticket has no team — cannot auto-assign')
  if (ticket.assigneeId) return ticket // Already assigned

  const team = await r.helpdeskTeams.findById(ticket.teamId)
  if (!team || team.memberIds.length === 0) throw new Error('Team has no members')

  let assigneeId: string

  if (team.assignmentMethod === 'round_robin') {
    // Count open tickets per member, assign to the one with fewest
    const memberCounts = await Promise.all(
      team.memberIds.map(async (memberId: string) => {
        const count = await r.tickets.count({
          orgId,
          assigneeId: memberId,
          state: { $in: ['new', 'in_progress', 'waiting'] },
        } as any)
        return { memberId, count }
      }),
    )
    memberCounts.sort((a, b) => a.count - b.count)
    assigneeId = memberCounts[0].memberId
  } else if (team.assignmentMethod === 'least_busy') {
    // Same as round_robin for now (could factor in SLA urgency later)
    const memberCounts = await Promise.all(
      team.memberIds.map(async (memberId: string) => {
        const count = await r.tickets.count({
          orgId,
          assigneeId: memberId,
          state: { $in: ['new', 'in_progress', 'waiting'] },
        } as any)
        return { memberId, count }
      }),
    )
    memberCounts.sort((a, b) => a.count - b.count)
    assigneeId = memberCounts[0].memberId
  } else {
    // Manual — assign to team leader
    assigneeId = team.leaderId
  }

  const updated = await r.tickets.update(ticketId, { assigneeId } as any)
  if (!updated) throw new Error('Failed to assign ticket')

  logger.info({ ticketId, assigneeId, method: team.assignmentMethod }, 'Ticket auto-assigned')
  return updated
}

/**
 * Transition ticket state with validation.
 */
export async function transitionTicket(
  ticketId: string,
  orgId: string,
  newState: string,
  repos?: RepositoryRegistry,
): Promise<ITicket> {
  const r = repos ?? getRepos()
  const ticket = await r.tickets.findOne({ id: ticketId, orgId } as any)
  if (!ticket) throw new Error('Ticket not found')

  // Validate transitions
  const allowedTransitions: Record<string, string[]> = {
    new: ['in_progress', 'waiting', 'resolved', 'closed'],
    in_progress: ['waiting', 'resolved', 'closed'],
    waiting: ['in_progress', 'resolved', 'closed'],
    resolved: ['in_progress', 'closed'],   // Reopen or close
    closed: ['in_progress'],                // Reopen only
  }

  const allowed = allowedTransitions[ticket.state] || []
  if (!allowed.includes(newState)) {
    throw new Error(`Cannot transition ticket from "${ticket.state}" to "${newState}"`)
  }

  const updates: any = { state: newState }

  // Track dates
  if (newState === 'in_progress' && !ticket.firstResponseDate) {
    updates.firstResponseDate = new Date()
  }
  if (newState === 'resolved') {
    updates.resolutionDate = new Date()
  }
  if (newState === 'closed') {
    updates.closedDate = new Date()
    if (!ticket.resolutionDate) updates.resolutionDate = new Date()
  }

  // Atomic update with state precondition
  const updated = await r.tickets.findOneAndUpdate(
    { id: ticketId, orgId, state: ticket.state } as any,
    updates,
  )
  if (!updated) throw new Error(`Concurrent modification on ticket ${ticket.name}`)

  logger.info({ ticketId, from: ticket.state, to: newState, name: ticket.name }, 'Ticket transitioned')
  return updated
}

/**
 * Check SLA breaches across all open tickets.
 * Called by background job (every 5 min).
 */
export async function checkSLABreaches(orgId: string, repos?: RepositoryRegistry): Promise<number> {
  const r = repos ?? getRepos()
  const now = new Date()

  // Find tickets that are past SLA deadline but not yet marked as breached
  const atRiskThreshold = new Date(now.getTime() + 30 * 60 * 1000) // 30 min warning

  // Mark breached
  const breachedCount = await r.tickets.updateMany(
    {
      orgId,
      state: { $in: ['new', 'in_progress', 'waiting'] },
      slaDeadline: { $lt: now },
      slaStatus: { $ne: 'breached' },
    } as any,
    { slaStatus: 'breached' } as any,
  )

  // Mark at_risk (within 30 min of deadline)
  await r.tickets.updateMany(
    {
      orgId,
      state: { $in: ['new', 'in_progress', 'waiting'] },
      slaDeadline: { $gte: now, $lte: atRiskThreshold },
      slaStatus: 'on_track',
    } as any,
    { slaStatus: 'at_risk' } as any,
  )

  if (breachedCount > 0) {
    logger.warn({ orgId, breachedCount }, 'SLA breaches detected')
  }

  return breachedCount
}
