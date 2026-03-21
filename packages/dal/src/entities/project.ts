import type { TenantEntity } from '../types.js'

export interface IProjectStage {
  name: string
  sequence: number
  fold: boolean
}

export interface IProject extends TenantEntity {
  name: string
  description?: string
  partnerId?: string
  state: string
  dateStart?: Date
  dateEnd?: Date
  managerId: string
  memberIds: string[]
  stages: IProjectStage[]
  color?: string
  tags?: string[]
  budgetPlanned: number
  budgetSpent: number
  revenueExpected: number
  revenueInvoiced: number
  isFavorite: boolean
  salesOrderId?: string
  roomId?: string
  createdBy: string
}

export interface IProjectTask extends TenantEntity {
  projectId: string
  name: string
  description?: string
  stageName: string
  state: string
  priority: string
  assigneeIds: string[]
  parentTaskId?: string
  dependencyIds: string[]
  dateDeadline?: Date
  dateStart?: Date
  dateEnd?: Date
  plannedHours: number
  effectiveHours: number
  remainingHours: number
  milestoneId?: string
  tags?: string[]
  isRecurring: boolean
  recurringInterval?: number
  recurringPeriod?: string
  createdBy: string
}

export interface IProjectMilestone extends TenantEntity {
  projectId: string
  name: string
  deadline: Date
  isReached: boolean
  reachedDate?: Date
  salesOrderLineIndex?: number
}

export interface IProjectTimesheet extends TenantEntity {
  employeeId: string
  projectId: string
  taskId?: string
  date: Date
  hours: number
  description?: string
  unitAmount: number
}
