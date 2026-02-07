import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IInvoiceLine {
  productId?: Types.ObjectId
  description: string
  quantity: number
  unit: string
  unitPrice: number
  discount: number
  taxRate: number
  taxAmount: number
  lineTotal: number
  accountId?: Types.ObjectId
  warehouseId?: Types.ObjectId
}

export interface IInvoicePayment {
  date: Date
  amount: number
  method: string
  reference?: string
  bankAccountId?: Types.ObjectId
  journalEntryId?: Types.ObjectId
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

export interface IInvoice extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  invoiceNumber: string
  type: string
  direction: string
  status: string
  contactId: Types.ObjectId
  issueDate: Date
  dueDate: Date
  currency: string
  exchangeRate: number
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
  relatedInvoiceId?: Types.ObjectId
  journalEntryId?: Types.ObjectId
  recurringConfig?: IInvoiceRecurringConfig
  attachments: Types.ObjectId[]
  sentAt?: Date
  paidAt?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const addressSchema = new Schema(
  {
    street: { type: String, required: true },
    city: { type: String, required: true },
    state: String,
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false },
)

const invoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: { type: String, required: true },
    type: { type: String, required: true, enum: ['invoice', 'proforma', 'credit_note', 'debit_note'] },
    direction: { type: String, required: true, enum: ['outgoing', 'incoming'] },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled'],
    },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    currency: { type: String, required: true },
    exchangeRate: { type: Number, required: true, default: 1 },
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product' },
        description: { type: String, required: true },
        quantity: { type: Number, required: true },
        unit: { type: String, required: true },
        unitPrice: { type: Number, required: true },
        discount: { type: Number, default: 0 },
        taxRate: { type: Number, required: true },
        taxAmount: { type: Number, required: true },
        lineTotal: { type: Number, required: true },
        accountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
      },
    ],
    subtotal: { type: Number, required: true },
    discountTotal: { type: Number, required: true, default: 0 },
    taxTotal: { type: Number, required: true },
    total: { type: Number, required: true },
    totalBase: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    amountDue: { type: Number, required: true },
    payments: [
      {
        date: { type: Date, required: true },
        amount: { type: Number, required: true },
        method: { type: String, required: true, enum: ['cash', 'bank_transfer', 'card', 'check', 'other'] },
        reference: String,
        bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
        journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      },
    ],
    notes: String,
    terms: String,
    footer: String,
    billingAddress: { type: addressSchema, required: true },
    shippingAddress: { type: addressSchema, required: false },
    relatedInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    recurringConfig: {
      enabled: Boolean,
      frequency: { type: String, enum: ['weekly', 'monthly', 'quarterly', 'yearly'] },
      nextDate: Date,
      endDate: Date,
    },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],
    sentAt: Date,
    paidAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

invoiceSchema.plugin(tenantPlugin)
invoiceSchema.index({ orgId: 1, invoiceNumber: 1 }, { unique: true })
invoiceSchema.index({ orgId: 1, contactId: 1 })
invoiceSchema.index({ orgId: 1, status: 1 })
invoiceSchema.index({ orgId: 1, direction: 1, issueDate: -1 })
invoiceSchema.index({ orgId: 1, dueDate: 1, status: 1 })

export const Invoice = model<IInvoice>('Invoice', invoiceSchema)
