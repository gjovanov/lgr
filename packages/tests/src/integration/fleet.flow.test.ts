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

async function createVehicle(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.vehicles.create({
    orgId: String(orgId),
    name: `AB-${Date.now()}-CD`,
    model: 'Sprinter',
    brand: 'Mercedes',
    state: 'active',
    fuelType: 'diesel',
    odometer: 15000,
    ...overrides,
  } as any)
}

describe('Fleet Management', () => {
  it('should create a vehicle', async () => {
    const org = await createTestOrg()

    const vehicle = await createVehicle(org._id)

    expect(vehicle.name).toContain('AB-')
    expect(vehicle.model).toBe('Sprinter')
    expect(vehicle.brand).toBe('Mercedes')
    expect(vehicle.state).toBe('active')
    expect(vehicle.odometer).toBe(15000)
  })

  it('should update vehicle odometer', async () => {
    const org = await createTestOrg()
    const vehicle = await createVehicle(org._id, { odometer: 10000 })

    const updated = await repos.vehicles.update(vehicle.id, { odometer: 15000 } as any)
    expect(updated!.odometer).toBe(15000)
  })

  it('should create fuel and service costs for a vehicle', async () => {
    const org = await createTestOrg()
    const vehicle = await createVehicle(org._id)

    const fuelCost = await repos.vehicleCosts.create({
      orgId: String(org._id),
      vehicleId: vehicle.id,
      type: 'fuel',
      amount: 85.50,
      date: new Date(),
      odometer: 15200,
      description: 'Full tank',
    } as any)

    const maintenanceCost = await repos.vehicleCosts.create({
      orgId: String(org._id),
      vehicleId: vehicle.id,
      type: 'maintenance',
      amount: 450,
      date: new Date(),
      description: 'Oil change + brake pads',
    } as any)

    expect(fuelCost.type).toBe('fuel')
    expect(fuelCost.amount).toBe(85.50)
    expect(maintenanceCost.type).toBe('maintenance')
    expect(maintenanceCost.amount).toBe(450)
  })

  it('should filter costs by vehicle and type', async () => {
    const org = await createTestOrg()
    const v1 = await createVehicle(org._id, { name: `V1-${Date.now()}` })
    const v2 = await createVehicle(org._id, { name: `V2-${Date.now()}` })

    await repos.vehicleCosts.create({ orgId: String(org._id), vehicleId: v1.id, type: 'fuel', amount: 80, date: new Date() } as any)
    await repos.vehicleCosts.create({ orgId: String(org._id), vehicleId: v1.id, type: 'maintenance', amount: 200, date: new Date() } as any)
    await repos.vehicleCosts.create({ orgId: String(org._id), vehicleId: v2.id, type: 'fuel', amount: 90, date: new Date() } as any)

    // Filter by vehicle
    const v1Costs = await repos.vehicleCosts.findAll(
      { orgId: String(org._id), vehicleId: v1.id },
      { page: 0, size: 10 },
    )
    expect(v1Costs.items).toHaveLength(2)

    // Filter by type
    const fuelCosts = await repos.vehicleCosts.findAll(
      { orgId: String(org._id), type: 'fuel' },
      { page: 0, size: 10 },
    )
    expect(fuelCosts.items).toHaveLength(2)

    // Filter by vehicle + type
    const v1Fuel = await repos.vehicleCosts.findAll(
      { orgId: String(org._id), vehicleId: v1.id, type: 'fuel' },
      { page: 0, size: 10 },
    )
    expect(v1Fuel.items).toHaveLength(1)
  })

  it('should list vehicles filtered by state', async () => {
    const org = await createTestOrg()
    await createVehicle(org._id, { name: `ACT-${Date.now()}`, state: 'active' })
    await createVehicle(org._id, { name: `RET-${Date.now()}`, state: 'sold' })
    await createVehicle(org._id, { name: `MNT-${Date.now()}`, state: 'in_service' })

    const active = await repos.vehicles.findAll(
      { orgId: String(org._id), state: 'active' },
      { page: 0, size: 10 },
    )
    expect(active.items).toHaveLength(1)

    const all = await repos.vehicles.findAll(
      { orgId: String(org._id) },
      { page: 0, size: 10 },
    )
    expect(all.items).toHaveLength(3)
  })
})
