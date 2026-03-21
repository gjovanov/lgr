import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import {
  applySLA,
  autoAssignTicket,
  transitionTicket,
  checkSLABreaches,
} from 'services/biz/helpdesk.service'
import type { Types } from 'mongoose'

let repos: ReturnType<typeof getRepos>

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
})

async function createTestTeam(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.helpdeskTeams.create({
    orgId: String(orgId),
    name: 'Support Team',
    memberIds: [String(orgId)],
    leaderId: String(orgId),
    assignmentMethod: 'manual',
    isActive: true,
    ...overrides,
  } as any)
}

async function createTestTicket(orgId: Types.ObjectId, overrides: any = {}) {
  const name = await getNextNumber(String(orgId), 'TKT')
  return repos.tickets.create({
    orgId: String(orgId),
    name,
    description: 'Something is broken',
    channelSource: 'manual',
    stageName: 'New',
    state: 'new',
    priority: 'normal',
    slaStatus: 'on_track',
    totalHours: 0,
    createdBy: String(orgId),
    ...overrides,
  } as any)
}

async function createTestSLAPolicy(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.slaPolicies.create({
    orgId: String(orgId),
    name: 'Standard SLA',
    priority: 'normal',
    targets: { firstResponseHours: 4, resolutionHours: 24 },
    businessHoursOnly: false,
    isActive: true,
    ...overrides,
  } as any)
}

describe('Helpdesk Ticket Lifecycle', () => {
  it('creates a ticket', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id)

    expect(ticket.name).toMatch(/^TKT-\d{4}-\d{5}$/)
    expect(ticket.state).toBe('new')
    expect(ticket.slaStatus).toBe('on_track')
  })

  it('applies SLA policy based on priority', async () => {
    const org = await createTestOrg()
    await createTestSLAPolicy(org._id)
    const ticket = await createTestTicket(org._id)

    const updated = await applySLA(ticket.id, String(org._id), repos)
    expect(updated.slaDeadline).toBeTruthy()
    expect(updated.slaStatus).toBe('on_track')
    // Deadline should be ~24h from creation
    const deadlineMs = new Date(updated.slaDeadline!).getTime() - ticket.createdAt.getTime()
    expect(deadlineMs).toBeCloseTo(24 * 60 * 60 * 1000, -3) // within ~1s precision
  })

  it('transitions ticket: new -> in_progress', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id)

    const updated = await transitionTicket(ticket.id, String(org._id), 'in_progress', repos)
    expect(updated.state).toBe('in_progress')
    expect(updated.firstResponseDate).toBeTruthy()
  })

  it('transitions ticket: in_progress -> resolved', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id, { state: 'in_progress' })

    const updated = await transitionTicket(ticket.id, String(org._id), 'resolved', repos)
    expect(updated.state).toBe('resolved')
    expect(updated.resolutionDate).toBeTruthy()
  })

  it('transitions ticket: resolved -> closed', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id, { state: 'resolved', resolutionDate: new Date() })

    const updated = await transitionTicket(ticket.id, String(org._id), 'closed', repos)
    expect(updated.state).toBe('closed')
    expect(updated.closedDate).toBeTruthy()
  })

  it('reopens a resolved ticket', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id, { state: 'resolved' })

    const updated = await transitionTicket(ticket.id, String(org._id), 'in_progress', repos)
    expect(updated.state).toBe('in_progress')
  })

  it('allows new -> closed directly', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id)

    // new -> closed IS allowed per the transition map
    const updated = await transitionTicket(ticket.id, String(org._id), 'closed', repos)
    expect(updated.state).toBe('closed')
  })

  it('rejects invalid transition: closed -> resolved', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id, { state: 'closed' })

    await expect(transitionTicket(ticket.id, String(org._id), 'resolved', repos))
      .rejects.toThrow(/Cannot transition/)
  })

  it('full lifecycle: new -> in_progress -> resolved -> closed', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id)

    const t1 = await transitionTicket(ticket.id, String(org._id), 'in_progress', repos)
    expect(t1.state).toBe('in_progress')
    expect(t1.firstResponseDate).toBeTruthy()

    const t2 = await transitionTicket(ticket.id, String(org._id), 'resolved', repos)
    expect(t2.state).toBe('resolved')
    expect(t2.resolutionDate).toBeTruthy()

    const t3 = await transitionTicket(ticket.id, String(org._id), 'closed', repos)
    expect(t3.state).toBe('closed')
    expect(t3.closedDate).toBeTruthy()
  })

  it('throws for non-existent ticket', async () => {
    await expect(transitionTicket('000000000000000000000099', '000000000000000000000001', 'resolved', repos))
      .rejects.toThrow(/not found/)
  })
})

describe('Auto-Assignment', () => {
  it('auto-assigns to leader when method is manual', async () => {
    const org = await createTestOrg()
    const team = await createTestTeam(org._id, { memberIds: [String(org._id)] })
    const ticket = await createTestTicket(org._id, { teamId: team.id })

    const assigned = await autoAssignTicket(ticket.id, String(org._id), repos)
    expect(assigned.assigneeId).toBe(team.leaderId)
  })

  it('skips assignment if already assigned', async () => {
    const org = await createTestOrg()
    const team = await createTestTeam(org._id)
    const ticket = await createTestTicket(org._id, {
      teamId: team.id,
      assigneeId: '000000000000000000000088',
    })

    const result = await autoAssignTicket(ticket.id, String(org._id), repos)
    expect(result.assigneeId).toBe('000000000000000000000088') // Unchanged
  })

  it('throws when ticket has no team', async () => {
    const org = await createTestOrg()
    const ticket = await createTestTicket(org._id)

    await expect(autoAssignTicket(ticket.id, String(org._id), repos))
      .rejects.toThrow(/no team/)
  })
})

describe('SLA Breach Detection', () => {
  it('marks overdue tickets as breached', async () => {
    const org = await createTestOrg()
    // Create ticket with past SLA deadline
    await createTestTicket(org._id, {
      slaDeadline: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      slaStatus: 'on_track',
    })

    const breachedCount = await checkSLABreaches(String(org._id), repos)
    expect(breachedCount).toBe(1)

    // Verify the ticket was updated
    const tickets = await repos.tickets.findMany({ orgId: String(org._id) } as any)
    expect(tickets[0].slaStatus).toBe('breached')
  })

  it('marks at-risk tickets within 30 min of deadline', async () => {
    const org = await createTestOrg()
    // Create ticket with deadline 15 min from now
    await createTestTicket(org._id, {
      slaDeadline: new Date(Date.now() + 15 * 60 * 1000),
      slaStatus: 'on_track',
    })

    await checkSLABreaches(String(org._id), repos)

    const tickets = await repos.tickets.findMany({ orgId: String(org._id) } as any)
    expect(tickets[0].slaStatus).toBe('at_risk')
  })

  it('does not mark tickets with future deadline', async () => {
    const org = await createTestOrg()
    await createTestTicket(org._id, {
      slaDeadline: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours from now
      slaStatus: 'on_track',
    })

    const breachedCount = await checkSLABreaches(String(org._id), repos)
    expect(breachedCount).toBe(0)

    const tickets = await repos.tickets.findMany({ orgId: String(org._id) } as any)
    expect(tickets[0].slaStatus).toBe('on_track')
  })
})
