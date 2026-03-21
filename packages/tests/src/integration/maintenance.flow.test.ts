import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { getRepos } from 'services/context'
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

async function createEquipment(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.equipment.create({
    orgId: String(orgId),
    name: 'CNC Mill #1',
    location: 'Workshop A',
    serialNumber: `SN-${Date.now()}`,
    ...overrides,
  } as any)
}

async function createMaintenanceRequest(
  orgId: Types.ObjectId,
  equipmentId: string,
  userId: string,
  overrides: any = {},
) {
  return repos.maintenanceRequests.create({
    orgId: String(orgId),
    name: 'Fix spindle bearing',
    equipmentId,
    type: 'corrective',
    priority: 'normal',
    state: 'draft',
    scheduledDate: new Date(),
    createdBy: userId,
    isRecurring: false,
    ...overrides,
  } as any)
}

describe('Maintenance Flow', () => {
  it('should create equipment', async () => {
    const org = await createTestOrg()

    const equip = await createEquipment(org._id)

    expect(equip.name).toBe('CNC Mill #1')
    expect(equip.location).toBe('Workshop A')
    expect(equip.serialNumber).toContain('SN-')
  })

  it('should create a corrective maintenance request', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const equip = await createEquipment(org._id)

    const request = await createMaintenanceRequest(org._id, equip.id, String(user._id))

    expect(request.name).toBe('Fix spindle bearing')
    expect(request.type).toBe('corrective')
    expect(request.state).toBe('draft')
    expect(request.equipmentId).toBe(equip.id)
  })

  it('should transition: new → in_progress → done with duration', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const equip = await createEquipment(org._id)

    const request = await createMaintenanceRequest(org._id, equip.id, String(user._id))

    // Start
    const started = await repos.maintenanceRequests.update(request.id, { state: 'in_progress' } as any)
    expect(started!.state).toBe('in_progress')

    // Complete
    const completed = await repos.maintenanceRequests.update(request.id, {
      state: 'done',
      completedDate: new Date(),
      duration: 4.5,
    } as any)
    expect(completed!.state).toBe('done')
    expect((completed as any).duration).toBe(4.5)
    expect((completed as any).completedDate).toBeTruthy()
  })

  it('should create a preventive maintenance request', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const equip = await createEquipment(org._id)

    const request = await createMaintenanceRequest(org._id, equip.id, String(user._id), {
      name: 'Quarterly lubrication',
      type: 'preventive',
      isRecurring: true,
      recurringDays: 90,
    })

    expect(request.type).toBe('preventive')
    expect(request.isRecurring).toBe(true)
    expect((request as any).recurringDays).toBe(90)
  })

  it('should cancel a maintenance request', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const equip = await createEquipment(org._id)

    const request = await createMaintenanceRequest(org._id, equip.id, String(user._id))

    const cancelled = await repos.maintenanceRequests.update(request.id, { state: 'cancelled' } as any)
    expect(cancelled!.state).toBe('cancelled')
  })

  it('should list maintenance requests filtered by equipment and state', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const equip1 = await createEquipment(org._id, { name: 'Equip 1' })
    const equip2 = await createEquipment(org._id, { name: 'Equip 2' })

    await createMaintenanceRequest(org._id, equip1.id, String(user._id), { name: 'Fix A', state: 'draft' })
    await createMaintenanceRequest(org._id, equip1.id, String(user._id), { name: 'Fix B', state: 'in_progress' })
    await createMaintenanceRequest(org._id, equip2.id, String(user._id), { name: 'Fix C', state: 'draft' })

    const equip1Requests = await repos.maintenanceRequests.findAll(
      { orgId: String(org._id), equipmentId: equip1.id },
      { page: 0, size: 10 },
    )
    expect(equip1Requests.items).toHaveLength(2)

    const draftRequests = await repos.maintenanceRequests.findAll(
      { orgId: String(org._id), state: 'draft' },
      { page: 0, size: 10 },
    )
    expect(draftRequests.items).toHaveLength(2)
  })
})
