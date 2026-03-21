import type { TenantEntity } from '../types.js'

export interface IFieldServicePart { productId: string; quantity: number; unitCost: number }

export interface IFieldServiceTask extends TenantEntity {
  name: string; description?: string; partnerId?: string; assigneeId: string
  projectId?: string; state: string; priority: string; dateScheduled: Date
  dateStart?: Date; dateEnd?: Date; location?: string; latitude?: number; longitude?: number
  plannedHours: number; effectiveHours: number; parts: IFieldServicePart[]
  totalPartsCost: number; totalLaborCost: number; worksheetNotes?: string
  customerSignature?: string; technicianSignature?: string
  invoiceId?: string; salesOrderId?: string; tags?: string[]; createdBy: string
}
