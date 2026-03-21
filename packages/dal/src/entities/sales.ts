import type { TenantEntity } from '../types.js'

// ── Sales Order Line ──

export interface ISalesOrderLine {
  productId?: string
  name: string
  quantity: number
  uom: string
  priceUnit: number
  discount: number
  taxRate: number
  taxAmount: number
  priceSubtotal: number
  priceTotal: number
  qtyDelivered: number
  qtyInvoiced: number
  warehouseId?: string
  scheduledDate?: Date
  priceExplanation?: { type: string; label: string; price: number }[]
}

// ── Sales Order ──

export interface ISalesOrder extends TenantEntity {
  name: string
  state: string
  partnerId: string
  partnerShippingId?: string
  partnerInvoiceId?: string
  dateOrder?: Date
  validityDate?: Date
  commitmentDate?: Date
  pricelistId?: string
  currency: string
  exchangeRate: number
  lines: ISalesOrderLine[]
  amountUntaxed: number
  amountTax: number
  amountTotal: number
  invoiceStatus: string
  deliveryStatus: string
  invoiceIds: string[]
  movementIds: string[]
  templateId?: string
  notes?: string
  termsAndConditions?: string
  requireSignature: boolean
  requirePayment: boolean
  signedBy?: string
  signedOn?: Date
  userId: string
  tags?: string[]
  sentAt?: Date
  confirmedAt?: Date
  createdBy: string
}

// ── Quotation Template ──

export interface IQuotationTemplateLine {
  productId?: string
  name: string
  quantity: number
  discount: number
}

export interface IQuotationTemplate extends TenantEntity {
  name: string
  lines: IQuotationTemplateLine[]
  optionalProductIds: string[]
  notes?: string
  termsAndConditions?: string
  validityDays: number
  isActive: boolean
}
