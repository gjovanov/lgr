import type { TenantEntity } from '../types.js'

export interface IWorkCenter extends TenantEntity {
  name: string; code: string; capacity: number; costPerHour: number
  setupTime: number; cleanupTime: number; isActive: boolean; notes?: string
}

export interface IRoutingStep { sequence: number; name: string; workCenterId: string; durationMinutes: number; description?: string }

export interface IRouting extends TenantEntity {
  name: string; productId?: string; bomId?: string; steps: IRoutingStep[]; isActive: boolean
}

export interface IECOChange { field: string; oldValue: string; newValue: string }

export interface IECO extends TenantEntity {
  name: string; productId: string; bomId?: string; state: string; type: string
  description: string; changes: IECOChange[]; requesterId: string; reviewerId?: string
  approvedDate?: Date; appliedDate?: Date; notes?: string; createdBy: string
}
