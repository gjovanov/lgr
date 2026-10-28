import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * InternalOrder (ORDI-) — a client's order for future delivery (the demand side).
 *
 * A client commits to buying the listed products by `requestedDeliveryDate`. Coverage
 * happens through Reservation (RES-) documents linking each line to a supply source
 * (free stock or an external ORDO allocation); shortfalls can generate a new draft
 * ORDO. Delivery happens through conversion sales invoices whose lines carry
 * orderRef.internalOrderId/internalOrderLineId back to this document.
 *
 * Lifecycle: draft → confirmed (ORDI number issued) → partially_delivered → delivered
 * (both derived from line deliveredQuantity by reservation.service) → completed
 * (manual; releases open reservation remainders), + cancelled (draft/confirmed only,
 * cascades reservation cancellation).
 *
 * Per-line reservedQuantity/invoicedQuantity/deliveredQuantity are DERIVED (from RES
 * docs and live conversion invoices) and recomputed by reservation.service.
 */

export interface IInternalOrderLine {
  _id: Types.ObjectId
  productId: Types.ObjectId
  description: string
  sku?: string
  quantity: number
  unit: string
  /** Indicative price shown on the order — actual invoice pricing goes through resolvePrice. */
  expectedUnitPrice?: number
  taxRate?: number
  notes?: string
  reservedQuantity: number
  invoicedQuantity: number
  deliveredQuantity: number
}

export interface IInternalOrderStatusEntry {
  status: string
  fromStatus?: string
  changedAt: Date
  changedBy?: Types.ObjectId
  reason?: string
}

export interface IInternalOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  status: string
  statusHistory: IInternalOrderStatusEntry[]
  contactId: Types.ObjectId
  issueDate: Date
  requestedDeliveryDate: Date
  priority: 'low' | 'normal' | 'high' | 'urgent'
  /** Preferred dispatch warehouse — default for reservation suggestions. */
  warehouseId?: Types.ObjectId
  currency: string
  exchangeRate: number
  lines: IInternalOrderLine[]
  notes?: string
  terms?: string
  tags?: string[]
  draftNumber?: string
  numberHistory?: Array<{ number: string; allocatedAt: Date; status: string }>
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const internalOrderLineSchema = new Schema<IInternalOrderLine>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    description: { type: String, required: true },
    sku: String,
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, default: 'pcs' },
    expectedUnitPrice: Number,
    taxRate: Number,
    notes: String,
    reservedQuantity: { type: Number, default: 0, min: 0 },
    invoicedQuantity: { type: Number, default: 0, min: 0 },
    deliveredQuantity: { type: Number, default: 0, min: 0 },
  },
)

const internalOrderSchema = new Schema<IInternalOrder>(
  {
    orderNumber: { type: String, required: true },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'confirmed', 'partially_delivered', 'delivered', 'completed', 'cancelled'],
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
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    issueDate: { type: Date, required: true },
    requestedDeliveryDate: { type: Date, required: true },
    priority: { type: String, required: true, default: 'normal', enum: ['low', 'normal', 'high', 'urgent'] },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    currency: { type: String, default: 'EUR' },
    exchangeRate: { type: Number, required: true, default: 1 },
    lines: [internalOrderLineSchema],
    notes: String,
    terms: String,
    tags: [String],
    draftNumber: String,
    numberHistory: [
      {
        _id: false,
        number: { type: String, required: true },
        allocatedAt: { type: Date, required: true, default: Date.now },
        status: { type: String, required: true },
      },
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

internalOrderSchema.plugin(tenantPlugin)
internalOrderSchema.index({ orgId: 1, orderNumber: 1 }, { unique: true })
internalOrderSchema.index({ orgId: 1, status: 1 })
internalOrderSchema.index({ orgId: 1, contactId: 1 })
internalOrderSchema.index({ orgId: 1, requestedDeliveryDate: 1 })

replicate(internalOrderSchema, { class: 'R' })

export const InternalOrder = model<IInternalOrder>('InternalOrder', internalOrderSchema)
