import type { TenantEntity } from '../types.js'

export interface IEquipment extends TenantEntity {
  name: string; categoryId?: string; location?: string; assignedToId?: string
  serialNumber?: string; purchaseDate?: Date; warrantyExpiry?: Date
  maintenanceTeamId?: string; expectedMTBF?: number; mttr?: number
  nextPreventiveDate?: Date; notes?: string
}

export interface IMaintenanceRequest extends TenantEntity {
  name: string; equipmentId: string; type: string; priority: string; state: string
  assigneeId?: string; scheduledDate: Date; completedDate?: Date; duration?: number
  description?: string; notes?: string; isRecurring: boolean; recurringDays?: number; createdBy: string
}
