import type { TenantEntity } from '../types.js'

// ── Purchase Order Line ──

export interface IPurchaseOrderLine {
  productId?: string
  name: string
  quantity: number
  uom: string
  priceUnit: number
  taxRate: number
  taxAmount: number
  priceSubtotal: number
  priceTotal: number
  qtyReceived: number
  qtyBilled: number
  scheduledDate?: Date
  warehouseId?: string
}

// ── Purchase Order ──

export interface IPurchaseOrder extends TenantEntity {
  name: string
  state: string
  vendorId: string
  dateOrder?: Date
  dateApproved?: Date
  datePlanned?: Date
  currency: string
  exchangeRate: number
  lines: IPurchaseOrderLine[]
  amountUntaxed: number
  amountTax: number
  amountTotal: number
  receiptStatus: string
  invoiceStatus: string
  invoiceIds: string[]
  movementIds: string[]
  agreementId?: string
  approvalStatus?: string
  approvedBy?: string
  notes?: string
  userId: string
  tags?: string[]
  sentAt?: Date
  confirmedAt?: Date
  createdBy: string
}

// ── Blanket Order Line ──

export interface IBlanketOrderLine {
  productId?: string
  name: string
  quantity: number
  priceUnit: number
  qtyOrdered: number
}

// ── Blanket Order ──

export interface IBlanketOrder extends TenantEntity {
  name: string
  vendorId: string
  state: string
  dateStart: Date
  dateEnd: Date
  currency: string
  lines: IBlanketOrderLine[]
  purchaseOrderIds: string[]
  notes?: string
  createdBy: string
}

// ── Reorder Rule ──

export interface IReorderRule extends TenantEntity {
  productId: string
  warehouseId: string
  minQty: number
  maxQty: number
  multipleQty?: number
  leadTimeDays: number
  vendorId?: string
  isActive: boolean
  lastTriggeredAt?: Date
}
