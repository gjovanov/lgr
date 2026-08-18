import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPriceStep {
  type: string
  label: string
  price: number
}

/**
 * Back-references from an invoice line into the order/reservation graph.
 * Supply side (ORDO): orderId/groupId/lineId/allocationId — set on ORD-linked bill
 * imports and on conversions consuming order-source reservations. Demand side (ORDI):
 * internalOrderId/internalOrderLineId — set on conversions executing an internal order.
 * reservationId points at the Reservation (RES-) document the line consumes; lines from
 * stock-source reservations carry only reservationId + the demand refs.
 */
export interface IInvoiceLineOrderRef {
  orderId?: Types.ObjectId
  groupId?: Types.ObjectId
  lineId?: Types.ObjectId
  allocationId?: Types.ObjectId
  reservationId?: Types.ObjectId
  internalOrderId?: Types.ObjectId
  internalOrderLineId?: Types.ObjectId
}

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
  priceExplanation?: IPriceStep[]
  /** Back-reference into the source Order (conversion / ORD-linked bill import). */
  orderRef?: IInvoiceLineOrderRef
  /** Original OCR-extracted description (before product matching) — feeds alias learning. */
  sourceText?: string
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

export interface IInvoiceStatusEntry {
  status: string
  fromStatus?: string
  changedAt: Date
  changedBy?: Types.ObjectId
  reason?: string
}

export interface IInvoice extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  invoiceNumber: string
  type: string
  direction: string
  status: string
  statusHistory: IInvoiceStatusEntry[]
  contactId?: Types.ObjectId
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
  /** How the document is (to be) paid: cash | card | bank_transfer | check. */
  paymentMethod?: string
  /** Съставил — who authored the document (OCR-imported name or the creating user). */
  preparedBy?: string
  /** Място на сделката — place of transaction (e.g. "гр.Пазарджик"). */
  placeOfTransaction?: string
  notes?: string
  terms?: string
  footer?: string
  billingAddress: IInvoiceAddress
  shippingAddress?: IInvoiceAddress
  relatedInvoiceId?: Types.ObjectId
  convertedInvoiceId?: Types.ObjectId
  proformaId?: Types.ObjectId
  /** Source external order (ORDO-) this document was generated from / received against. */
  orderId?: Types.ObjectId
  /** The supplier group inside the order (ORDO-linked purchase bills). */
  orderGroupId?: Types.ObjectId
  /** Source internal order (ORDI-) this conversion invoice executes. */
  internalOrderId?: Types.ObjectId
  journalEntryId?: Types.ObjectId
  recurringConfig?: IInvoiceRecurringConfig
  attachments: Types.ObjectId[]
  pendingTransferIds?: Types.ObjectId[]
  sentAt?: Date
  paidAt?: Date
  tags?: string[]
  /** The pre-issue draft number (e.g. "DRF-INV-2026-00007") preserved on send so the
   * issued invoice keeps a pointer to its draft history. */
  draftNumber?: string
  /** Декларация за съответствие number, allocated from the CERTIFICATE counter the first
   * time the companion document is printed and reused by every later reprint. */
  certificateNumber?: string
  /** Приемо-предавателен протокол number, allocated from the PP_PROTOCOL counter on first
   * print and reused by every later reprint. */
  ppProtocolNumber?: string
  /** Append-only log of every number this document has carried, in allocation order. */
  numberHistory?: Array<{ number: string; allocatedAt: Date; status: string }>
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

// All fields optional: real-world counterparties often lack a postal code (or a
// structured address at all) — saving must not be blocked by address completeness.
const addressSchema = new Schema(
  {
    street: String,
    city: String,
    state: String,
    postalCode: String,
    country: String,
  },
  { _id: false },
)

const invoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: { type: String, required: true },
    type: { type: String, required: true, enum: ['invoice', 'proforma', 'credit_note', 'debit_note', 'cash_sale'] },
    direction: { type: String, required: true, enum: ['outgoing', 'incoming'] },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'sent', 'received', 'partially_paid', 'paid', 'overdue', 'voided', 'cancelled', 'converted'],
    },
    statusHistory: [
      {
        status: { type: String, required: true },
        fromStatus: String,
        changedAt: { type: Date, required: true, default: Date.now },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        reason: String,
      },
    ],
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    currency: { type: String, default: 'EUR' },
    exchangeRate: { type: Number, required: true, default: 1 },
    reference: String,
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
        priceExplanation: [
          {
            type: { type: String, enum: ['base', 'category', 'tag', 'contact', 'tier', 'override'] },
            label: String,
            price: Number,
          },
        ],
        orderRef: {
          type: new Schema(
            {
              orderId: Schema.Types.ObjectId,
              groupId: Schema.Types.ObjectId,
              lineId: Schema.Types.ObjectId,
              allocationId: Schema.Types.ObjectId,
              reservationId: Schema.Types.ObjectId,
              internalOrderId: Schema.Types.ObjectId,
              internalOrderLineId: Schema.Types.ObjectId,
            },
            { _id: false },
          ),
          required: false,
        },
        sourceText: String,
      },
    ],
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    totalBase: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
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
    paymentMethod: String,
    preparedBy: String,
    placeOfTransaction: String,
    notes: String,
    terms: String,
    footer: String,
    billingAddress: { type: addressSchema, required: true },
    shippingAddress: { type: addressSchema, required: false },
    relatedInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    convertedInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    proformaId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    orderGroupId: { type: Schema.Types.ObjectId },
    internalOrderId: { type: Schema.Types.ObjectId, ref: 'InternalOrder' },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    recurringConfig: {
      enabled: Boolean,
      frequency: { type: String, enum: ['weekly', 'monthly', 'quarterly', 'yearly'] },
      nextDate: Date,
      endDate: Date,
    },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],
    pendingTransferIds: [{ type: Schema.Types.ObjectId, ref: 'StockMovement' }],
    sentAt: Date,
    paidAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tags: [String],
    draftNumber: String,
    certificateNumber: String,
    ppProtocolNumber: String,
    numberHistory: [
      {
        _id: false,
        number: { type: String, required: true },
        allocatedAt: { type: Date, required: true, default: Date.now },
        status: { type: String, required: true },
      },
    ],
  },
  { timestamps: true },
)

invoiceSchema.plugin(tenantPlugin)
invoiceSchema.index({ orgId: 1, invoiceNumber: 1 }, { unique: true })
invoiceSchema.index({ orgId: 1, contactId: 1 })
invoiceSchema.index({ orgId: 1, status: 1 })
invoiceSchema.index({ orgId: 1, direction: 1, issueDate: -1 })
invoiceSchema.index({ orgId: 1, dueDate: 1, status: 1 })
invoiceSchema.index({ orgId: 1, tags: 1 })
invoiceSchema.index({ orgId: 1, orderId: 1 })
invoiceSchema.index({ orgId: 1, internalOrderId: 1 })
invoiceSchema.index({ orgId: 1, 'lines.orderRef.reservationId': 1 })
invoiceSchema.index({ invoiceNumber: 'text', notes: 'text', reference: 'text' })

export const Invoice = model<IInvoice>('Invoice', invoiceSchema)
