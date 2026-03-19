import type { TenantEntity } from '../types.js'

// ── Contact ──

export interface IContactAddress {
  id?: string
  type: string
  street: string
  street2?: string
  city: string
  state?: string
  postalCode: string
  country: string
  isDefault: boolean
}

export interface IContactBankDetail {
  id?: string
  bankName: string
  accountNumber: string
  iban?: string
  swift?: string
  currency: string
  isDefault: boolean
}

export interface IContact extends TenantEntity {
  type: string
  companyName?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  mobile?: string
  website?: string
  taxId?: string
  taxNumber?: string
  vatNumber?: string
  registrationNumber?: string
  addresses: IContactAddress[]
  bankDetails: IContactBankDetail[]
  currency?: string
  paymentTermsDays: number
  creditLimit?: number
  discount?: number
  notes?: string
  tags?: string[]
  accountReceivableId?: string
  accountPayableId?: string
  isActive: boolean
}

// ── Pricing ──

export interface IPriceStep {
  type: 'base' | 'category' | 'tag' | 'contact' | 'override'
  label: string
  price: number
}

// ── Invoice ──

export interface IInvoiceLine {
  id?: string
  productId?: string
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
  accountId?: string
  warehouseId?: string
  priceExplanation?: IPriceStep[]
}

export interface IInvoicePayment {
  id?: string
  date: Date
  amount: number
  method: string
  reference?: string
  bankAccountId?: string
  journalEntryId?: string
}

export interface IInvoiceAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface IInvoiceRecurringConfig {
  enabled: boolean
  frequency: string
  nextDate: Date
  endDate?: Date
}

export interface IInvoice extends TenantEntity {
  invoiceNumber: string
  type: string
  direction: string
  status: string
  contactId: string
  issueDate: Date
  dueDate: Date
  currency: string
  exchangeRate: number
  reference?: string
  lines: IInvoiceLine[]
  subtotal: number
  discountTotal: number
  taxTotal: number
  total: number
  totalBase: number
  amountPaid: number
  amountDue: number
  payments: IInvoicePayment[]
  notes?: string
  terms?: string
  footer?: string
  billingAddress: IInvoiceAddress
  shippingAddress?: IInvoiceAddress
  relatedInvoiceId?: string
  convertedInvoiceId?: string
  proformaId?: string
  journalEntryId?: string
  recurringConfig?: IInvoiceRecurringConfig
  attachments: string[]
  sentAt?: Date
  paidAt?: Date
  tags?: string[]
  createdBy: string
}

// ── PaymentOrder ──

export interface IPaymentOrder extends TenantEntity {
  orderNumber: string
  type: string
  contactId: string
  bankAccountId: string
  amount: number
  currency: string
  exchangeRate: number
  invoiceIds: string[]
  reference?: string
  description?: string
  status: string
  executedAt?: Date
  journalEntryId?: string
  createdBy: string
}

// ── CashOrder ──

export interface ICashOrder extends TenantEntity {
  orderNumber: string
  type: string
  contactId?: string
  amount: number
  currency: string
  description: string
  accountId: string
  counterAccountId: string
  journalEntryId?: string
  createdBy: string
}
