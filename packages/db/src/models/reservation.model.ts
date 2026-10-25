import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/**
 * Reservation (RES-) — a numbered hold linking one client demand to one supply source.
 *
 * Demand side: the client (contactId), optionally a specific internal order line
 * (ORDI). Supply side: either free warehouse stock (`source: 'stock'`) or an external
 * order allocation (`source: 'order'` → orderId/groupId/lineId/allocationId point into
 * the ORDO's subdocuments).
 *
 * Stock holds are materialised into StockLevel.reservedQuantity by reservation.service:
 *   - stock-source, active:  hold = max(0, quantity − dispatchedQuantity)
 *   - order-source: per allocation, min(Σ open, received − Σ dispatched), and only
 *     while the parent ORDO is in a holding status (sent/partially_received/received).
 *
 * invoicedQuantity/dispatchedQuantity/invoiceIds are DERIVED from live outgoing
 * conversion invoices referencing this reservation (orderRef.reservationId) and are
 * recomputed by reservation.service — never incremented in place.
 *
 * Quantity may legitimately reach 0 (cancel/release shrink it down); the create API
 * enforces > 0. Cancelled is terminal; fulfilled auto-reverts to active only while the
 * linked demand is still live (a completed ORDI never resurrects a hold — the quantity
 * is shrunk instead).
 */

export interface IReservationStatusEntry {
  status: string
  fromStatus?: string
  changedAt: Date
  changedBy?: Types.ObjectId
  reason?: string
}

export interface IReservation extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  reservationNumber: string
  status: 'active' | 'fulfilled' | 'cancelled'
  statusHistory: IReservationStatusEntry[]
  // demand
  contactId: Types.ObjectId
  internalOrderId?: Types.ObjectId
  internalOrderLineId?: Types.ObjectId
  /** Denormalised from the ORDI (priority sorting) — refreshed by sync. */
  requestedDeliveryDate?: Date
  // supply
  source: 'stock' | 'order'
  warehouseId: Types.ObjectId
  orderId?: Types.ObjectId
  groupId?: Types.ObjectId
  lineId?: Types.ObjectId
  allocationId?: Types.ObjectId
  /** Denormalised from the ORDO (feasibility vs the ORDI deadline) — refreshed by sync. */
  expectedDate?: Date
  // quantities
  /** Denormalised from the ORDO line for order-source; may be absent for migrated
   * reservations on product-less lines. Required by the create API. */
  productId?: Types.ObjectId
  quantity: number
  invoicedQuantity: number
  dispatchedQuantity: number
  invoiceIds: Types.ObjectId[]
  // audit
  cancelReason?: 'manual' | 'preempted' | 'internal_order_cancelled' | 'external_order_cancelled' | 'released'
  preemptedBy?: {
    internalOrderId?: Types.ObjectId
    reservationId?: Types.ObjectId
    userId?: Types.ObjectId
    at: Date
  }
  notes?: string
  /**
   * The cancelled reservation this one repeats (#203: „Резервирай отново"). Unique: a cancelled
   * reservation is repeated once — a double click, or two people, cannot hold the goods twice.
   * To repeat again after cancelling the repeat, repeat the repeat.
   */
  repeatOf?: Types.ObjectId
  createdBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const reservationSchema = new Schema<IReservation>(
  {
    reservationNumber: { type: String, required: true },
    status: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'fulfilled', 'cancelled'],
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
    internalOrderId: { type: Schema.Types.ObjectId, ref: 'InternalOrder' },
    internalOrderLineId: { type: Schema.Types.ObjectId },
    requestedDeliveryDate: Date,
    source: { type: String, required: true, enum: ['stock', 'order'] },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    groupId: { type: Schema.Types.ObjectId },
    lineId: { type: Schema.Types.ObjectId },
    allocationId: { type: Schema.Types.ObjectId },
    expectedDate: Date,
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, required: true, min: 0 },
    invoicedQuantity: { type: Number, default: 0, min: 0 },
    dispatchedQuantity: { type: Number, default: 0, min: 0 },
    invoiceIds: [{ type: Schema.Types.ObjectId, ref: 'Invoice' }],
    cancelReason: {
      type: String,
      enum: ['manual', 'preempted', 'internal_order_cancelled', 'external_order_cancelled', 'released'],
    },
    preemptedBy: {
      type: new Schema(
        {
          internalOrderId: { type: Schema.Types.ObjectId, ref: 'InternalOrder' },
          reservationId: { type: Schema.Types.ObjectId, ref: 'Reservation' },
          userId: { type: Schema.Types.ObjectId, ref: 'User' },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
    notes: String,
    repeatOf: { type: Schema.Types.ObjectId, ref: 'Reservation' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

reservationSchema.plugin(tenantPlugin)
reservationSchema.index({ orgId: 1, reservationNumber: 1 }, { unique: true })
reservationSchema.index({ orgId: 1, status: 1, productId: 1, warehouseId: 1 })
reservationSchema.index({ orgId: 1, internalOrderId: 1 })
reservationSchema.index({ orgId: 1, orderId: 1 })
reservationSchema.index({ orgId: 1, contactId: 1 })
reservationSchema.index(
  { orgId: 1, repeatOf: 1 },
  { unique: true, partialFilterExpression: { repeatOf: { $exists: true } } },
)

replicate(reservationSchema, { class: 'R' })

export const Reservation = model<IReservation>('Reservation', reservationSchema)
