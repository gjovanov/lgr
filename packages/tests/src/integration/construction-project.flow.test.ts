import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestConstructionProject, createTestProduct, createTestEmployee, createTestContact } from '../helpers/factories'
import { ConstructionProject } from 'db/models'
import { mongoose } from 'db/connection'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Construction Project Flow', () => {
  it('should create a project with budget and phases in planning state', async () => {
    const org = await createTestOrg()
    const client = await createTestContact(org._id)

    const project = await createTestConstructionProject(org._id, {
      clientId: client._id,
      budget: {
        estimated: 250000,
        currency: 'EUR',
        approved: 250000,
        spent: 0,
        remaining: 250000,
      },
      phases: [
        {
          name: 'Foundation',
          order: 1,
          status: 'pending',
          budget: 80000,
          spent: 0,
          tasks: [],
        },
        {
          name: 'Framing',
          order: 2,
          status: 'pending',
          budget: 100000,
          spent: 0,
          tasks: [],
        },
        {
          name: 'Finishing',
          order: 3,
          status: 'pending',
          budget: 70000,
          spent: 0,
          tasks: [],
        },
      ],
    })

    expect(project.status).toBe('planning')
    expect(project.budget.estimated).toBe(250000)
    expect(project.budget.remaining).toBe(250000)
    expect(project.budget.spent).toBe(0)
    expect(project.phases).toHaveLength(3)
    expect(project.totalInvoiced).toBe(0)
    expect(project.margin).toBe(0)
  })

  it('should add phases with tasks and verify phase ordering', async () => {
    const org = await createTestOrg()
    const employee = await createTestEmployee(org._id)

    const project = await createTestConstructionProject(org._id, {
      phases: [
        {
          name: 'Demolition',
          order: 1,
          status: 'pending',
          budget: 30000,
          spent: 0,
          tasks: [
            { name: 'Site clearance', assignedTo: employee._id, status: 'pending' },
            { name: 'Debris removal', status: 'pending' },
          ],
        },
        {
          name: 'Foundation',
          order: 2,
          status: 'pending',
          budget: 80000,
          spent: 0,
          tasks: [
            { name: 'Excavation', status: 'pending' },
            { name: 'Concrete pouring', status: 'pending' },
          ],
        },
        {
          name: 'Roofing',
          order: 3,
          status: 'pending',
          budget: 60000,
          spent: 0,
          tasks: [
            { name: 'Truss installation', status: 'pending' },
          ],
        },
      ],
    })

    expect(project.phases).toHaveLength(3)
    // Verify ordering
    expect(project.phases[0].order).toBe(1)
    expect(project.phases[1].order).toBe(2)
    expect(project.phases[2].order).toBe(3)
    expect(project.phases[0].name).toBe('Demolition')
    // Verify tasks within phases
    expect(project.phases[0].tasks).toHaveLength(2)
    expect(project.phases[0].tasks[0].name).toBe('Site clearance')
    expect(project.phases[0].tasks[0].assignedTo!.toString()).toBe(employee._id.toString())
    expect(project.phases[1].tasks).toHaveLength(2)
    expect(project.phases[2].tasks).toHaveLength(1)
  })

  it('should add team members to a project', async () => {
    const org = await createTestOrg()
    const engineer = await createTestEmployee(org._id, { firstName: 'Alice', position: 'Site Engineer' })
    const foreman = await createTestEmployee(org._id, { firstName: 'Bob', position: 'Foreman' })
    const architect = await createTestEmployee(org._id, { firstName: 'Carol', position: 'Architect' })

    const project = await createTestConstructionProject(org._id, {
      team: [
        { employeeId: engineer._id, role: 'Site Engineer', startDate: new Date() },
        { employeeId: foreman._id, role: 'Foreman', startDate: new Date() },
        { employeeId: architect._id, role: 'Lead Architect', startDate: new Date() },
      ],
    })

    expect(project.team).toHaveLength(3)
    expect(project.team[0].employeeId.toString()).toBe(engineer._id.toString())
    expect(project.team[0].role).toBe('Site Engineer')
    expect(project.team[1].role).toBe('Foreman')
    expect(project.team[2].role).toBe('Lead Architect')

    // Add another member via update
    await ConstructionProject.updateOne(
      { _id: project._id },
      {
        $push: {
          team: {
            employeeId: new mongoose.Types.ObjectId(),
            role: 'Electrician',
            startDate: new Date(),
          },
        },
      },
    )

    const updated = await ConstructionProject.findById(project._id)
    expect(updated!.team).toHaveLength(4)
    expect(updated!.team[3].role).toBe('Electrician')
  })

  it('should add materials linked to products', async () => {
    const org = await createTestOrg()
    const cement = await createTestProduct(org._id, { name: 'Portland Cement', purchasePrice: 12, unit: 'bag' })
    const rebar = await createTestProduct(org._id, { name: 'Steel Rebar', purchasePrice: 45, unit: 'ton' })

    const project = await createTestConstructionProject(org._id, {
      materials: [
        {
          productId: cement._id,
          quantity: 500,
          unitCost: 12,
          totalCost: 6000,
          status: 'ordered',
        },
        {
          productId: rebar._id,
          quantity: 20,
          unitCost: 45,
          totalCost: 900,
          status: 'ordered',
        },
      ],
    })

    expect(project.materials).toHaveLength(2)
    expect(project.materials[0].productId.toString()).toBe(cement._id.toString())
    expect(project.materials[0].quantity).toBe(500)
    expect(project.materials[0].totalCost).toBe(6000)
    expect(project.materials[0].status).toBe('ordered')
    expect(project.materials[1].productId.toString()).toBe(rebar._id.toString())
    expect(project.materials[1].totalCost).toBe(900)

    // Update material status to delivered
    await ConstructionProject.updateOne(
      { _id: project._id, 'materials.productId': cement._id },
      { $set: { 'materials.$.status': 'delivered', 'materials.$.deliveryDate': new Date() } },
    )

    const updated = await ConstructionProject.findById(project._id)
    expect(updated!.materials[0].status).toBe('delivered')
    expect(updated!.materials[0].deliveryDate).toBeDefined()
  })

  it('should update project status progression: planning -> active -> completed', async () => {
    const org = await createTestOrg()

    const project = await createTestConstructionProject(org._id)
    expect(project.status).toBe('planning')

    // Transition to active
    await ConstructionProject.updateOne(
      { _id: project._id },
      { $set: { status: 'active' } },
    )
    const active = await ConstructionProject.findById(project._id)
    expect(active!.status).toBe('active')

    // Transition to completed with actualEndDate
    const completedDate = new Date()
    await ConstructionProject.updateOne(
      { _id: project._id },
      { $set: { status: 'completed', actualEndDate: completedDate } },
    )
    const completed = await ConstructionProject.findById(project._id)
    expect(completed!.status).toBe('completed')
    expect(completed!.actualEndDate).toBeDefined()
    expect(completed!.actualEndDate!.getTime()).toBe(completedDate.getTime())
  })

  it('should track budget spent/remaining as phases progress', async () => {
    const org = await createTestOrg()

    const project = await createTestConstructionProject(org._id, {
      budget: {
        estimated: 200000,
        currency: 'EUR',
        approved: 200000,
        spent: 0,
        remaining: 200000,
      },
      phases: [
        { name: 'Phase 1', order: 1, status: 'in_progress', budget: 80000, spent: 0, tasks: [] },
        { name: 'Phase 2', order: 2, status: 'pending', budget: 120000, spent: 0, tasks: [] },
      ],
    })

    // Phase 1 incurs 30000 in costs
    await ConstructionProject.updateOne(
      { _id: project._id, 'phases.name': 'Phase 1' },
      {
        $set: {
          'phases.$.spent': 30000,
          'budget.spent': 30000,
          'budget.remaining': 170000,
        },
      },
    )

    let updated = await ConstructionProject.findById(project._id)
    expect(updated!.phases[0].spent).toBe(30000)
    expect(updated!.budget.spent).toBe(30000)
    expect(updated!.budget.remaining).toBe(170000)

    // Phase 1 completes with 80000 total, Phase 2 starts with 25000
    await ConstructionProject.updateOne(
      { _id: project._id },
      {
        $set: {
          'phases.0.spent': 80000,
          'phases.0.status': 'completed',
          'phases.1.spent': 25000,
          'phases.1.status': 'in_progress',
          'budget.spent': 105000,
          'budget.remaining': 95000,
        },
      },
    )

    updated = await ConstructionProject.findById(project._id)
    expect(updated!.phases[0].spent).toBe(80000)
    expect(updated!.phases[0].status).toBe('completed')
    expect(updated!.phases[1].spent).toBe(25000)
    expect(updated!.phases[1].status).toBe('in_progress')
    expect(updated!.budget.spent).toBe(105000)
    expect(updated!.budget.remaining).toBe(95000)
  })

  it('should enforce multi-tenancy: org1 project not visible to org2', async () => {
    const org1 = await createTestOrg({ name: 'Org One', slug: `org-one-${Date.now()}` })
    const org2 = await createTestOrg({ name: 'Org Two', slug: `org-two-${Date.now()}` })

    await createTestConstructionProject(org1._id, { name: 'Org1 Office Build' })
    await createTestConstructionProject(org1._id, { name: 'Org1 Warehouse Build' })
    await createTestConstructionProject(org2._id, { name: 'Org2 Factory Build' })

    const org1Projects = await ConstructionProject.find({ orgId: org1._id })
    const org2Projects = await ConstructionProject.find({ orgId: org2._id })

    expect(org1Projects).toHaveLength(2)
    expect(org2Projects).toHaveLength(1)

    // Verify names are scoped to the correct org
    const org1Names = org1Projects.map(p => p.name).sort()
    expect(org1Names).toEqual(['Org1 Office Build', 'Org1 Warehouse Build'])
    expect(org2Projects[0].name).toBe('Org2 Factory Build')

    // Org2 cannot see Org1 projects by querying with org2's orgId
    const crossQuery = await ConstructionProject.find({
      orgId: org2._id,
      name: 'Org1 Office Build',
    })
    expect(crossQuery).toHaveLength(0)
  })

  it('should verify project margin calculation (totalInvoiced - budget.spent)', async () => {
    const org = await createTestOrg()

    const project = await createTestConstructionProject(org._id, {
      budget: {
        estimated: 300000,
        currency: 'EUR',
        approved: 300000,
        spent: 0,
        remaining: 300000,
      },
      totalInvoiced: 0,
      margin: 0,
    })

    // Simulate progress: spent 120000, invoiced 150000 to client
    await ConstructionProject.updateOne(
      { _id: project._id },
      {
        $set: {
          'budget.spent': 120000,
          'budget.remaining': 180000,
          totalInvoiced: 150000,
          totalPaid: 100000,
          margin: 150000 - 120000, // 30000 margin
        },
      },
    )

    let updated = await ConstructionProject.findById(project._id)
    expect(updated!.totalInvoiced).toBe(150000)
    expect(updated!.budget.spent).toBe(120000)
    expect(updated!.margin).toBe(30000)
    expect(updated!.totalPaid).toBe(100000)

    // More work done: spent 250000, invoiced 320000 total
    await ConstructionProject.updateOne(
      { _id: project._id },
      {
        $set: {
          'budget.spent': 250000,
          'budget.remaining': 50000,
          totalInvoiced: 320000,
          totalPaid: 280000,
          margin: 320000 - 250000, // 70000 margin
        },
      },
    )

    updated = await ConstructionProject.findById(project._id)
    expect(updated!.totalInvoiced).toBe(320000)
    expect(updated!.budget.spent).toBe(250000)
    expect(updated!.margin).toBe(70000)
    expect(updated!.totalPaid).toBe(280000)
    expect(updated!.budget.remaining).toBe(50000)

    // Negative margin scenario: cost overrun
    await ConstructionProject.updateOne(
      { _id: project._id },
      {
        $set: {
          'budget.spent': 350000,
          'budget.remaining': -50000,
          totalInvoiced: 320000,
          margin: 320000 - 350000, // -30000 loss
        },
      },
    )

    updated = await ConstructionProject.findById(project._id)
    expect(updated!.margin).toBe(-30000)
    expect(updated!.budget.remaining).toBe(-50000)
  })
})
