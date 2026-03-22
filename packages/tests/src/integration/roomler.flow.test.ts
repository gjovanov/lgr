import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, spyOn } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { getRepos } from 'services/context'
import { eventBus } from 'services/events/event-bus'
import { registerEventHandlers, resetEventHandlers } from 'services/events/handlers'
import { config } from 'config'

let repos: ReturnType<typeof getRepos>

// Save original config values to restore after tests
let originalRoomlerEnabled: boolean
let originalRoomlerUrl: string

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
  originalRoomlerEnabled = config.externalIntegrations.roomler.enabled
  originalRoomlerUrl = config.externalIntegrations.roomler.url
})

afterAll(async () => {
  // Restore original config
  ;(config.externalIntegrations.roomler as any).enabled = originalRoomlerEnabled
  ;(config.externalIntegrations.roomler as any).url = originalRoomlerUrl
  await teardownTestDB()
})

// Helper: wait for async event handlers to complete
const flush = () => new Promise((r) => setTimeout(r, 300))

function enableRoomler() {
  ;(config.externalIntegrations.roomler as any).enabled = true
  ;(config.externalIntegrations.roomler as any).url = 'http://mock-roomler:3000'
}

function disableRoomler() {
  ;(config.externalIntegrations.roomler as any).enabled = false
}

describe('Roomler Integration: project.created', () => {
  beforeEach(async () => {
    await clearCollections()
    eventBus.removeAllListeners()
    resetEventHandlers()
  })

  it('creates a Roomler room and updates project roomId when enabled', async () => {
    enableRoomler()

    // Mock global fetch to intercept Roomler API call
    const mockRoomId = 'room-abc-123'
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('mock-roomler:3000/api/rooms')) {
        const body = JSON.parse(init?.body as string)
        return new Response(JSON.stringify({
          id: mockRoomId,
          name: body.name,
          url: `/rooms/${mockRoomId}`,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return originalFetch(url, init as any)
    }) as any

    try {
      registerEventHandlers()

      const org = await createTestOrg()
      const orgId = String(org._id)
      const manager = await createTestUser(org._id, { operatorCode: 'MGR01' })
      const member = await createTestUser(org._id, { operatorCode: 'MBR01' })

      // Create a project in DB first
      const project = await repos.projects.create({
        orgId,
        name: 'Test Project',
        state: 'active',
        managerId: String(manager._id),
        memberIds: [String(member._id)],
        budgetPlanned: 1000,
        budgetSpent: 0,
        revenueExpected: 2000,
        revenueInvoiced: 0,
        isFavorite: false,
        stages: [{ name: 'New', sequence: 1, fold: false }],
        createdBy: String(manager._id),
      } as any)

      // Emit the event
      eventBus.emit('project.created', {
        projectId: project.id,
        orgId,
        name: 'Test Project',
        managerId: String(manager._id),
        memberIds: [String(member._id)],
      })

      await flush()

      // Verify fetch was called with correct Roomler API URL
      expect(globalThis.fetch).toHaveBeenCalled()

      // Verify project was updated with roomId
      const updatedProject = await repos.projects.findById(project.id)
      expect((updatedProject as any).roomId).toBe(mockRoomId)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not call Roomler API when integration is disabled', async () => {
    disableRoomler()

    const fetchSpy = mock(async () => new Response('{}'))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as any

    try {
      registerEventHandlers()

      const org = await createTestOrg()
      const orgId = String(org._id)

      eventBus.emit('project.created', {
        projectId: '000000000000000000000099',
        orgId,
        name: 'Test Project',
        managerId: '000000000000000000000001',
        memberIds: [],
      })

      await flush()

      // fetch should not have been called for Roomler
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Roomler Integration: ticket.created', () => {
  beforeEach(async () => {
    await clearCollections()
    eventBus.removeAllListeners()
    resetEventHandlers()
  })

  it('creates a Roomler room for ticket with chat channel', async () => {
    enableRoomler()

    const mockRoomId = 'room-ticket-456'
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('mock-roomler:3000/api/rooms')) {
        return new Response(JSON.stringify({
          id: mockRoomId,
          name: 'Ticket room',
          url: `/rooms/${mockRoomId}`,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return originalFetch(url, init as any)
    }) as any

    try {
      registerEventHandlers()

      const org = await createTestOrg()
      const orgId = String(org._id)
      const user = await createTestUser(org._id)

      // Create a ticket in DB first
      const ticket = await repos.tickets.create({
        orgId,
        name: 'TKT-001',
        description: 'Test ticket',
        channelSource: 'chat',
        state: 'new',
        priority: 'normal',
        slaStatus: 'on_track',
        totalHours: 0,
        assigneeId: String(user._id),
        createdBy: String(user._id),
      } as any)

      eventBus.emit('ticket.created', {
        ticketId: ticket.id,
        orgId,
        name: 'TKT-001',
        assigneeId: String(user._id),
        channelSource: 'chat',
      })

      await flush()

      expect(globalThis.fetch).toHaveBeenCalled()

      const updatedTicket = await repos.tickets.findById(ticket.id)
      expect((updatedTicket as any).roomId).toBe(mockRoomId)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does NOT create a Roomler room for ticket with manual channel', async () => {
    enableRoomler()

    const fetchSpy = mock(async () => new Response('{}', { status: 200 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as any

    try {
      registerEventHandlers()

      const org = await createTestOrg()
      const orgId = String(org._id)

      eventBus.emit('ticket.created', {
        ticketId: '000000000000000000000099',
        orgId,
        name: 'TKT-002',
        assigneeId: '000000000000000000000001',
        channelSource: 'manual',
      })

      await flush()

      // fetch should not be called because channelSource is 'manual', not 'chat'
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not call Roomler API for ticket when integration is disabled', async () => {
    disableRoomler()

    const fetchSpy = mock(async () => new Response('{}'))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as any

    try {
      registerEventHandlers()

      const org = await createTestOrg()
      const orgId = String(org._id)

      eventBus.emit('ticket.created', {
        ticketId: '000000000000000000000099',
        orgId,
        name: 'TKT-003',
        assigneeId: '000000000000000000000001',
        channelSource: 'chat',
      })

      await flush()

      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
