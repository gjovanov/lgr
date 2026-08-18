import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

/**
 * Order (ORDO-) — external procurement-planning document, grouped by supplier.
 *
 * Each supplier group carries its own line table (one purchase list per supplier).
 * Each line splits the ordered quantity across warehouse allocations. Client
 * reservations are FIRST-CLASS Reservation (RES-) documents pointing at these
 * allocations (orderId/groupId/lineId/allocationId) — the embedded `reservations`
 * arrays below are DEPRECATED: kept only so the migration script can read legacy
 * data; new code never writes them (they are emptied by the migration's strip phase).
 *
 * Lifecycle: draft → sent (ordered from suppliers) → partially_received → received
 * → completed (open reservation remainders released), + cancelled (cascades
 * reservation cancellation). Conversion to sales invoices is per client, from the
 * linked reservations (1 order → N invoices).
 */

export interface IOrderReservation {
  _id: Types.ObjectId
  contactId: Types.ObjectId
  quantity: number
  /** Quantity already carried onto sales invoices for this client (consumes the open-to-convert amount). */
  invoicedQuantity: number
  /** Quantity actually dispatched (invoice sent) — releases the stock hold in step with the physical drop. */
  dispatchedQuantity: number
  invoiceIds: Types.ObjectId[]
}

export interface IOrderAllocation {
  _id: Types.ObjectId
  warehouseId: Types.ObjectId
  quantity: number
  /** Quantity received into this warehouse via linked purchase bills. */
  receivedQuantity: number
  reservations: IOrderReservation[]
}

export interface IOrderLine {
  _id: Types.ObjectId
  productId?: Types.ObjectId
  description: string
  sku?: string
  quantity: number
  unit: string
  /** Expected/target purchase price — optional (RFQ sheets go out without prices). */
  expectedUnitPrice?: number
  taxRate?: number
  receivedQuantity: number
  allocations: IOrderAllocation[]
}

export interface IOrderSupplierGroup {
  _id: Types.ObjectId
  supplierId: Types.ObjectId
  reference?: string
  notes?: string
  lines: IOrderLine[]
}

export interface IOrderStatusEntry {
  status: string
  fromStatus?: string
  changedAt: Date
  changedBy?: Types.ObjectId
  reason?: string
}

export interface IOrder extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  orderNumber: string
  status: string
  statusHistory: IOrderStatusEntry[]
  issueDate: Date
  expectedDate?: Date
  currency: string
  exchangeRate: number
  supplierGroups: IOrderSupplierGroup[]
  notes?: string
  terms?: string
  tags?: string[]
  draftNumber?: string
  numberHistory?: Array<{ number: string; allocatedAt: Date; status: string }>
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const reservationSchema = new Schema<IOrderReservation>(
  {
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    quantity: { type: Number, required: true, min: 0 },
    invoicedQuantity: { type: Number, default: 0, min: 0 },
    dispatchedQuantity: { type: Number, default: 0, min: 0 },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
  },
)

const allocationSchema = new Schema<IOrderAllocation>(
  {
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    quantity: { type: Number, required: true, min: 0 },
    receivedQuantity: { type: Number, default: 0, min: 0 },
    reservations: [reservationSchema],
  },
)

const orderLineSchema = new Schema<IOrderLine>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    description: { type: String, required: true },
    sku: String,
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, default: 'pcs' },
    expectedUnitPrice: Number,
    taxRate: Number,
    receivedQuantity: { type: Number, default: 0, min: 0 },
    allocations: [allocationSchema],
  },
)

const supplierGroupSchema = new Schema<IOrderSupplierGroup>(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    reference: String,
    notes: String,
    lines: [orderLineSchema],
  },
)

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'sent', 'partially_received', 'received', 'completed', 'cancelled'],
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
    issueDate: { type: Date, required: true },
    expectedDate: Date,
    currency: { type: String, default: 'EUR' },
    exchangeRate: { type: Number, required: true, default: 1 },
    supplierGroups: [supplierGroupSchema],
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

orderSchema.plugin(tenantPlugin)
orderSchema.index({ orgId: 1, orderNumber: 1 }, { unique: true })
orderSchema.index({ orgId: 1, status: 1 })
orderSchema.index({ orgId: 1, 'supplierGroups.supplierId': 1 })

export const Order = model<IOrder>('Order', orderSchema)
