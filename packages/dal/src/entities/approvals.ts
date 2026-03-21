import type { TenantEntity } from '../types.js'

export interface IApprovalStepConfig {
  order: number
  name: string
  approverType: string
  approverId?: string
  approverRole?: string
  required: boolean
}

export interface IApprovalType extends TenantEntity {
  name: string
  entityType: string
  description?: string
  steps: IApprovalStepConfig[]
  isActive: boolean
}

export interface IApprovalStepResult {
  order: number
  approverId: string
  decision: string
  decidedDate?: Date
  comment?: string
}

export interface IApprovalRequest extends TenantEntity {
  typeId: string
  entityType: string
  entityId: string
  requesterId: string
  state: string
  currentStep: number
  steps: IApprovalStepResult[]
  requestedDate: Date
  decidedDate?: Date
  notes?: string
}
