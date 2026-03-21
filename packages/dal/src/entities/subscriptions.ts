import type { TenantEntity } from '../types.js'

export interface ISubscriptionLine {
  productId?: string
  name: string
  quantity: number
  priceUnit: number
  discount: number
  priceSubtotal: number
}

export interface ISubscription extends TenantEntity {
  name: string
  partnerId: string
  state: string
  lines: ISubscriptionLine[]
  recurringInterval: number
  recurringPeriod: string
  dateStart: Date
  dateEnd?: Date
  nextInvoiceDate: Date
  currency: string
  amountRecurring: number
  paymentMethod?: string
  autoRenew: boolean
  cancellationReason?: string
  cancellationDate?: Date
  invoiceIds: string[]
  salesOrderId?: string
  notes?: string
  createdBy: string
}
