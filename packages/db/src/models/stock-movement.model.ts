import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IStockMovementLine {
  productId: Types.ObjectId
  quantity: number
  unitCost: number
  totalCost: number
  batchNumber?: string
  expiryDate?: Date
  serialNumbers?: string[]
}

export interface IStockMovement extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  movementNumber: string
  type: string
  status: string
  date: Date
  fromWarehouseId?: Types.ObjectId
  toWarehouseId?: Types.ObjectId
  contactId?: Types.ObjectId
  invoiceId?: Types.ObjectId
  productionOrderId?: Types.ObjectId
  lines: IStockMovementLine[]
  totalAmount: number
  notes?: string
  journalEntryId?: Types.ObjectId
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    movementNumber: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out'],
    },
    status: { type: String, required: true, default: 'draft', enum: ['draft', 'confirmed', 'completed', 'cancelled'] },
    date: { type: Date, default: Date.now },
    fromWarehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    toWarehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    productionOrderId: { type: Schema.Types.ObjectId, ref: 'ProductionOrder' },
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        quantity: { type: Number, required: true },
        unitCost: { type: Number, required: true },
        totalCost: { type: Number, required: true },
        batchNumber: String,
        expiryDate: Date,
        serialNumbers: [String],
      },
    ],
    totalAmount: { type: Number, default: 0 },
    notes: String,
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

stockMovementSchema.plugin(tenantPlugin)
stockMovementSchema.index({ orgId: 1, movementNumber: 1 }, { unique: true })
stockMovementSchema.index({ orgId: 1, type: 1, date: -1 })
stockMovementSchema.index({ orgId: 1, 'lines.productId': 1, date: -1 })

export const StockMovement = model<IStockMovement>('StockMovement', stockMovementSchema)
