import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { getRepos } from 'services/context'
import { config } from 'config'
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

describe('TickyTack timesheet sync', () => {
  it('creates ProjectTimesheet records from TickyTack entries', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    // Enable tickytack in config temporarily
    const original = config.externalIntegrations.tickytack.enabled
    config.externalIntegrations.tickytack.enabled = true

    // Mock global fetch
    const mockEntries = [
      {
        id: 'tt-entry-1',
        projectId: orgId,
        ticketId: undefined,
        userId: orgId,
        date: '2026-03-20',
        startTime: '09:00',
        endTime: '11:00',
        durationMinutes: 120,
        description: 'Worked on feature A',
      },
      {
        id: 'tt-entry-2',
        projectId: orgId,
        userId: orgId,
        date: '2026-03-21',
        startTime: '14:00',
        endTime: '16:30',
        durationMinutes: 150,
        description: 'Code review',
      },
    ]

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ entries: mockEntries }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    ) as any

    try {
      const { syncTimesheets } = await import('services/biz/tickytack.service')
      const result = await syncTimesheets(orgId, '2026-03-20', '2026-03-21', repos)

      expect(result.created).toBe(2)
      expect(result.updated).toBe(0)

      // Verify records in DB
      const all = await repos.projectTimesheets.findAll({ orgId } as any, { page: 0, size: 100 })
      expect(all.items.length).toBe(2)

      const entry1 = all.items.find((e: any) => e.externalId === 'tt-entry-1')
      expect(entry1).toBeDefined()
      expect(entry1!.hours).toBe(2)
      expect(entry1!.description).toBe('Worked on feature A')
      expect((entry1 as any).externalSource).toBe('tickytack')

      const entry2 = all.items.find((e: any) => e.externalId === 'tt-entry-2')
      expect(entry2).toBeDefined()
      expect(entry2!.hours).toBe(2.5)
    } finally {
      globalThis.fetch = originalFetch
      config.externalIntegrations.tickytack.enabled = original
    }
  })

  it('updates existing records by externalId (idempotent)', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    const original = config.externalIntegrations.tickytack.enabled
    config.externalIntegrations.tickytack.enabled = true

    // Pre-create a timesheet with externalId
    await repos.projectTimesheets.create({
      orgId,
      employeeId: orgId,
      projectId: orgId,
      date: new Date('2026-03-20'),
      hours: 1,
      description: 'Old description',
      unitAmount: 0,
      externalId: 'tt-entry-1',
      externalSource: 'tickytack',
    } as any)

    const mockEntries = [
      {
        id: 'tt-entry-1',
        projectId: orgId,
        userId: orgId,
        date: '2026-03-20',
        startTime: '09:00',
        endTime: '12:00',
        durationMinutes: 180,
        description: 'Updated description',
      },
    ]

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ entries: mockEntries }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    ) as any

    try {
      const { syncTimesheets } = await import('services/biz/tickytack.service')
      const result = await syncTimesheets(orgId, '2026-03-20', '2026-03-20', repos)

      expect(result.created).toBe(0)
      expect(result.updated).toBe(1)

      // Verify the record was updated
      const all = await repos.projectTimesheets.findAll({ orgId } as any, { page: 0, size: 100 })
      expect(all.items.length).toBe(1)
      expect(all.items[0].hours).toBe(3)
      expect(all.items[0].description).toBe('Updated description')
    } finally {
      globalThis.fetch = originalFetch
      config.externalIntegrations.tickytack.enabled = original
    }
  })

  it('returns 0/0 with empty response from TickyTack', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    const original = config.externalIntegrations.tickytack.enabled
    config.externalIntegrations.tickytack.enabled = true

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ entries: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    ) as any

    try {
      const { syncTimesheets } = await import('services/biz/tickytack.service')
      const result = await syncTimesheets(orgId, '2026-03-20', '2026-03-21', repos)

      expect(result.created).toBe(0)
      expect(result.updated).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      config.externalIntegrations.tickytack.enabled = original
    }
  })

  it('returns 0/0 when TickyTack is disabled', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    // Ensure disabled
    const original = config.externalIntegrations.tickytack.enabled
    config.externalIntegrations.tickytack.enabled = false

    try {
      const { syncTimesheets } = await import('services/biz/tickytack.service')
      const result = await syncTimesheets(orgId, '2026-03-20', '2026-03-21', repos)

      expect(result.created).toBe(0)
      expect(result.updated).toBe(0)
    } finally {
      config.externalIntegrations.tickytack.enabled = original
    }
  })
})
