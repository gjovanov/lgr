import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { getRepos } from 'services/context'
import {
  syncTaskHours,
  reachMilestone,
  getProjectProfitability,
} from 'services/biz/project.service'
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

async function createTestProject(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.projects.create({
    orgId: String(orgId),
    name: 'Test Project',
    state: 'active',
    managerId: String(orgId),
    memberIds: [],
    stages: [
      { name: 'To Do', sequence: 1, fold: false },
      { name: 'In Progress', sequence: 2, fold: false },
      { name: 'Done', sequence: 3, fold: true },
    ],
    budgetPlanned: 10000,
    budgetSpent: 0,
    revenueExpected: 15000,
    revenueInvoiced: 0,
    isFavorite: false,
    createdBy: String(orgId),
    ...overrides,
  } as any)
}

async function createTestTask(orgId: Types.ObjectId, projectId: string, overrides: any = {}) {
  return repos.projectTasks.create({
    orgId: String(orgId),
    projectId,
    name: 'Test Task',
    stageName: 'To Do',
    state: 'open',
    priority: 'normal',
    assigneeIds: [],
    dependencyIds: [],
    plannedHours: 8,
    effectiveHours: 0,
    remainingHours: 8,
    isRecurring: false,
    createdBy: String(orgId),
    ...overrides,
  } as any)
}

describe('Project Management', () => {
  it('creates a project with default stages', async () => {
    const org = await createTestOrg()
    const project = await createTestProject(org._id)

    expect(project.name).toBe('Test Project')
    expect(project.state).toBe('active')
    expect(project.stages).toHaveLength(3)
    expect(project.budgetPlanned).toBe(10000)
  })

  it('creates a task in a project', async () => {
    const org = await createTestOrg()
    const project = await createTestProject(org._id)
    const task = await createTestTask(org._id, project.id)

    expect(task.projectId).toBe(project.id)
    expect(task.stageName).toBe('To Do')
    expect(task.state).toBe('open')
    expect(task.plannedHours).toBe(8)
    expect(task.remainingHours).toBe(8)
  })

  it('creates subtasks', async () => {
    const org = await createTestOrg()
    const project = await createTestProject(org._id)
    const parent = await createTestTask(org._id, project.id, { name: 'Parent Task' })
    const child = await createTestTask(org._id, project.id, {
      name: 'Child Task',
      parentTaskId: parent.id,
    })

    expect(child.parentTaskId).toBe(parent.id)
  })

  it('syncs task hours from timesheets', async () => {
    const org = await createTestOrg()
    const project = await createTestProject(org._id)
    const task = await createTestTask(org._id, project.id, { plannedHours: 20 })

    // Create timesheet entries
    await repos.projectTimesheets.create({
      orgId: String(org._id),
      employeeId: String(org._id),
      projectId: project.id,
      taskId: task.id,
      date: new Date(),
      hours: 5,
      unitAmount: 250,
    } as any)
    await repos.projectTimesheets.create({
      orgId: String(org._id),
      employeeId: String(org._id),
      projectId: project.id,
      taskId: task.id,
      date: new Date(),
      hours: 3,
      unitAmount: 150,
    } as any)

    const synced = await syncTaskHours(task.id, String(org._id), repos)
    expect(synced.effectiveHours).toBe(8)
    expect(synced.remainingHours).toBe(12) // 20 planned - 8 effective

    // Verify project budget updated
    const updatedProject = await repos.projects.findById(project.id)
    expect(updatedProject!.budgetSpent).toBe(400) // 250 + 150
  })

  it('reaches a milestone', async () => {
    const org = await createTestOrg()
    const project = await createTestProject(org._id)
    const milestone = await repos.projectMilestones.create({
      orgId: String(org._id),
      projectId: project.id,
      name: 'MVP Release',
      deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      isReached: false,
    } as any)

    await reachMilestone(milestone.id, String(org._id), repos)

    const updated = await repos.projectMilestones.findById(milestone.id)
    expect(updated!.isReached).toBe(true)
    expect(updated!.reachedDate).toBeTruthy()
  })

  it('rejects reaching an already-reached milestone', async () => {
    const org = await createTestOrg()
    const project = await createTestProject(org._id)
    const milestone = await repos.projectMilestones.create({
      orgId: String(org._id),
      projectId: project.id,
      name: 'Done Milestone',
      deadline: new Date(),
      isReached: true,
      reachedDate: new Date(),
    } as any)

    await expect(reachMilestone(milestone.id, String(org._id), repos))
      .rejects.toThrow(/already reached/)
  })

  it('computes project profitability', async () => {
    const org = await createTestOrg()
    const project = await createTestProject(org._id, {
      budgetPlanned: 10000,
      revenueExpected: 15000,
    })

    // Add timesheets
    await repos.projectTimesheets.create({
      orgId: String(org._id),
      employeeId: String(org._id),
      projectId: project.id,
      date: new Date(),
      hours: 40,
      unitAmount: 4000,
    } as any)

    const prof = await getProjectProfitability(project.id, String(org._id), repos)
    expect(prof.budgetPlanned).toBe(10000)
    expect(prof.budgetSpent).toBe(4000)
    expect(prof.budgetRemaining).toBe(6000)
    expect(prof.revenueExpected).toBe(15000)
    expect(prof.totalHours).toBe(40)
    expect(prof.profitMargin).toBe(73.33) // ((15000 - 4000) / 15000) * 100
  })

  it('throws for non-existent project', async () => {
    await expect(getProjectProfitability('000000000000000000000099', '000000000000000000000001', repos))
      .rejects.toThrow(/not found/)
  })
})
