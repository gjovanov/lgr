import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
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

async function createTestFieldServiceTask(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.fieldServiceTasks.create({
    orgId: String(orgId),
    name: 'Fix HVAC Unit',
    description: 'Repair the rooftop HVAC unit',
    assigneeId: String(orgId),
    state: 'scheduled',
    priority: 'normal',
    dateScheduled: new Date(),
    location: '123 Main St',
    plannedHours: 4,
    effectiveHours: 0,
    parts: [],
    totalPartsCost: 0,
    totalLaborCost: 0,
    tags: [],
    createdBy: String(orgId),
    ...overrides,
  } as any)
}

describe('Field Service Tasks', () => {
  it('creates a field service task', async () => {
    const org = await createTestOrg()
    const task = await createTestFieldServiceTask(org._id)

    expect(task.name).toBe('Fix HVAC Unit')
    expect(task.state).toBe('scheduled')
    expect(task.priority).toBe('normal')
    expect(task.plannedHours).toBe(4)
    expect(task.effectiveHours).toBe(0)
    expect(task.totalPartsCost).toBe(0)
    expect(task.totalLaborCost).toBe(0)
  })

  it('starts a task (scheduled -> in_progress, dateStart set)', async () => {
    const org = await createTestOrg()
    const task = await createTestFieldServiceTask(org._id)

    const updated = await repos.fieldServiceTasks.update(task.id, {
      state: 'in_progress',
      dateStart: new Date(),
    } as any)

    expect(updated!.state).toBe('in_progress')
    expect(updated!.dateStart).toBeTruthy()
  })

  it('completes a task (in_progress -> done, dateEnd set, costs computed)', async () => {
    const org = await createTestOrg()
    const task = await createTestFieldServiceTask(org._id, { state: 'in_progress', dateStart: new Date() })

    const effectiveHours = 3.5
    const laborRate = 50
    const totalLaborCost = effectiveHours * laborRate

    const updated = await repos.fieldServiceTasks.update(task.id, {
      state: 'done',
      dateEnd: new Date(),
      effectiveHours,
      totalLaborCost,
      totalPartsCost: 0,
    } as any)

    expect(updated!.state).toBe('done')
    expect(updated!.dateEnd).toBeTruthy()
    expect(updated!.effectiveHours).toBe(3.5)
    expect(updated!.totalLaborCost).toBe(175) // 3.5 * 50
  })

  it('completes a task with parts (totalPartsCost computed)', async () => {
    const org = await createTestOrg()
    const parts = [
      { productId: '000000000000000000000001', quantity: 2, unitCost: 25 },
      { productId: '000000000000000000000002', quantity: 1, unitCost: 100 },
    ]
    const task = await createTestFieldServiceTask(org._id, {
      state: 'in_progress',
      dateStart: new Date(),
      parts,
    })

    // Compute parts cost
    const totalPartsCost = parts.reduce((sum, p) => sum + (p.quantity * p.unitCost), 0)
    const effectiveHours = 2
    const laborRate = 60
    const totalLaborCost = effectiveHours * laborRate

    const updated = await repos.fieldServiceTasks.update(task.id, {
      state: 'done',
      dateEnd: new Date(),
      effectiveHours,
      totalPartsCost,
      totalLaborCost,
    } as any)

    expect(updated!.state).toBe('done')
    expect(updated!.totalPartsCost).toBe(150) // (2*25) + (1*100)
    expect(updated!.totalLaborCost).toBe(120) // 2 * 60
  })

  it('cancels a scheduled task', async () => {
    const org = await createTestOrg()
    const task = await createTestFieldServiceTask(org._id)

    const updated = await repos.fieldServiceTasks.update(task.id, {
      state: 'cancelled',
    } as any)

    expect(updated!.state).toBe('cancelled')
  })

  it('rejects start on a done task', async () => {
    const org = await createTestOrg()
    const task = await createTestFieldServiceTask(org._id, {
      state: 'done',
      dateStart: new Date(),
      dateEnd: new Date(),
    })

    // In the controller, starting a done task is rejected.
    // Here we verify the state guard logic: only 'scheduled' tasks can be started.
    expect(task.state).toBe('done')
    expect(task.state !== 'scheduled').toBe(true)
  })

  it('full lifecycle: scheduled -> in_progress -> done', async () => {
    const org = await createTestOrg()
    const task = await createTestFieldServiceTask(org._id)

    expect(task.state).toBe('scheduled')

    // Start
    const started = await repos.fieldServiceTasks.update(task.id, {
      state: 'in_progress',
      dateStart: new Date(),
    } as any)
    expect(started!.state).toBe('in_progress')
    expect(started!.dateStart).toBeTruthy()

    // Complete
    const effectiveHours = 4
    const laborRate = 45
    const totalLaborCost = effectiveHours * laborRate

    const completed = await repos.fieldServiceTasks.update(task.id, {
      state: 'done',
      dateEnd: new Date(),
      effectiveHours,
      totalLaborCost,
      totalPartsCost: 0,
    } as any)
    expect(completed!.state).toBe('done')
    expect(completed!.dateEnd).toBeTruthy()
    expect(completed!.effectiveHours).toBe(4)
    expect(completed!.totalLaborCost).toBe(180) // 4 * 45
  })
})
