import type { RepositoryRegistry } from 'dal'
import type { IProject, IProjectTask } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

/**
 * Compute project budget spent from timesheets.
 */
export async function computeProjectBudget(
  projectId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<{ budgetSpent: number; totalHours: number }> {
  const r = repos ?? getRepos()
  const timesheets = await r.projectTimesheets.findMany({
    orgId,
    projectId,
  } as any)

  const totalHours = timesheets.reduce((sum, ts) => sum + (ts.hours || 0), 0)
  const budgetSpent = timesheets.reduce((sum, ts) => sum + (ts.unitAmount || 0), 0)

  return { budgetSpent: Math.round(budgetSpent * 100) / 100, totalHours }
}

/**
 * Update task effective hours from timesheets and sync to project budget.
 */
export async function syncTaskHours(
  taskId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<IProjectTask> {
  const r = repos ?? getRepos()
  const task = await r.projectTasks.findOne({ id: taskId, orgId } as any)
  if (!task) throw new Error('Task not found')

  const timesheets = await r.projectTimesheets.findMany({
    orgId,
    taskId,
  } as any)

  const effectiveHours = timesheets.reduce((sum, ts) => sum + (ts.hours || 0), 0)
  const remainingHours = Math.max(0, (task.plannedHours || 0) - effectiveHours)

  const updated = await r.projectTasks.update(taskId, {
    effectiveHours: Math.round(effectiveHours * 100) / 100,
    remainingHours: Math.round(remainingHours * 100) / 100,
  } as any)
  if (!updated) throw new Error('Failed to update task hours')

  // Also update project budget
  const { budgetSpent } = await computeProjectBudget(task.projectId, orgId, r)
  await r.projects.update(task.projectId, { budgetSpent } as any)

  logger.info({ taskId, effectiveHours }, 'Task hours synced from timesheets')
  return updated
}

/**
 * Mark a milestone as reached and check for milestone-based invoicing.
 */
export async function reachMilestone(
  milestoneId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<void> {
  const r = repos ?? getRepos()
  const milestone = await r.projectMilestones.findOne({ id: milestoneId, orgId } as any)
  if (!milestone) throw new Error('Milestone not found')
  if (milestone.isReached) throw new Error('Milestone already reached')

  await r.projectMilestones.update(milestoneId, {
    isReached: true,
    reachedDate: new Date(),
  } as any)

  logger.info({ milestoneId, name: milestone.name }, 'Milestone reached')
}

/**
 * Get project profitability summary.
 */
export async function getProjectProfitability(
  projectId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<{
  budgetPlanned: number
  budgetSpent: number
  budgetRemaining: number
  revenueExpected: number
  revenueInvoiced: number
  profitMargin: number
  totalHours: number
}> {
  const r = repos ?? getRepos()
  const project = await r.projects.findOne({ id: projectId, orgId } as any)
  if (!project) throw new Error('Project not found')

  const { budgetSpent, totalHours } = await computeProjectBudget(projectId, orgId, r)

  const budgetRemaining = project.budgetPlanned - budgetSpent
  const profitMargin = project.revenueExpected > 0
    ? Math.round(((project.revenueExpected - budgetSpent) / project.revenueExpected) * 10000) / 100
    : 0

  return {
    budgetPlanned: project.budgetPlanned,
    budgetSpent,
    budgetRemaining: Math.round(budgetRemaining * 100) / 100,
    revenueExpected: project.revenueExpected,
    revenueInvoiced: project.revenueInvoiced,
    profitMargin,
    totalHours,
  }
}
