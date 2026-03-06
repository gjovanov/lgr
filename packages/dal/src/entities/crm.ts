import type { TenantEntity } from '../types.js'

// ── Lead ──

export interface ILead extends TenantEntity {
  source: string
  status: string
  companyName?: string
  contactName: string
  email?: string
  phone?: string
  website?: string
  industry?: string
  estimatedValue?: number
  currency?: string
  notes?: string
  assignedTo?: string
  convertedToContactId?: string
  convertedToDealId?: string
  convertedAt?: Date
  tags?: string[]
  customFields?: Record<string, any>
}

// ── Deal ──

export interface IDealProduct {
  id?: string
  productId: string
  quantity: number
  unitPrice: number
  discount?: number
  total: number
}

export interface IDeal extends TenantEntity {
  name: string
  contactId: string
  stage: string
  pipelineId: string
  value: number
  currency: string
  probability: number
  expectedCloseDate?: Date
  actualCloseDate?: Date
  status: string
  lostReason?: string
  assignedTo: string
  products?: IDealProduct[]
  notes?: string
  tags?: string[]
  customFields?: Record<string, any>
}

// ── Pipeline ──

export interface IPipelineStage {
  id?: string
  name: string
  order: number
  probability: number
  color: string
}

export interface IPipeline extends TenantEntity {
  name: string
  stages: IPipelineStage[]
  isDefault: boolean
  isActive: boolean
}

// ── Activity ──

export interface IActivity extends TenantEntity {
  type: string
  subject: string
  description?: string
  contactId?: string
  dealId?: string
  leadId?: string
  assignedTo: string
  dueDate?: Date
  completedAt?: Date
  status: string
  priority: string
  duration?: number
  outcome?: string
}
