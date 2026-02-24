import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPOSSession extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  warehouseId: Types.ObjectId
  cashierId: Types.ObjectId
  sessionNumber: string
  openedAt: Date
  closedAt?: Date
  status: string
  openingBalance: number
  closingBalance?: number
  expectedBalance?: number
  difference?: number
  currency: string
  totalSales: number
  totalReturns: number
  totalCash: number
  totalCard: number
  transactionCount: number
  createdAt: Date
  updatedAt: Date
}

const posSessionSchema = new Schema<IPOSSession>(
  {
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionNumber: { type: String, required: true },
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
    status: {
      type: String,
      required: true,
      default: 'open',
      enum: ['open', 'closed'],
    },
    openingBalance: { type: Number, required: true },
    closingBalance: Number,
    expectedBalance: Number,
    difference: Number,
    currency: { type: String, default: 'EUR' },
    totalSales: { type: Number, required: true, default: 0 },
    totalReturns: { type: Number, required: true, default: 0 },
    totalCash: { type: Number, required: true, default: 0 },
    totalCard: { type: Number, required: true, default: 0 },
    transactionCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
)

posSessionSchema.plugin(tenantPlugin)
posSessionSchema.index({ orgId: 1, cashierId: 1, openedAt: -1 })

export const POSSession = model<IPOSSession>('POSSession', posSessionSchema)
