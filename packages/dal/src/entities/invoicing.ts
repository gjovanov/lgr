import type { TenantEntity } from '../types.js'
import type { EntityOf, Plain } from '../entity-of.js'
import type {
  IInvoice as DbInvoice, IInvoiceLine as DbInvoiceLine, IInvoicePayment as DbInvoicePayment, IPriceStep as DbPriceStep,
  IInvoiceCashSaleRef as DbInvoiceCashSaleRef, IInvoiceAddress as DbInvoiceAddress, IInvoiceRecurringConfig as DbInvoiceRecurringConfig,
} from 'db/models'

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
  /** The person legally responsible for the company (МОЛ), FR-25a. */
  representative?: string
  tags?: string[]
  /** Other names the company is written under on documents („Also known as", FR-28.12). */
  aliases?: string[]
  accountReceivableId?: string
  accountPayableId?: string
  isActive: boolean
  deactivatedAt?: Date
}

// ── Pricing ──

/*
 * FR-32.15 (#797): the invoice's types come from its model (`db/models/invoice.model.ts`), not a second copy here.
 * Until then this file restated 43 of the model's fields by hand, and nothing tied the two together.
 */
export type IPriceStep = Plain<DbPriceStep>
export type IInvoiceLine = Plain<DbInvoiceLine>
export type IInvoiceCashSaleRef = Plain<DbInvoiceCashSaleRef>
export type IInvoicePayment = Plain<DbInvoicePayment>
export type IInvoiceAddress = Plain<DbInvoiceAddress>
export type IInvoiceRecurringConfig = Plain<DbInvoiceRecurringConfig>
export type IInvoice = EntityOf<DbInvoice>

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
