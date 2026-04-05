import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IOperationType extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code: string
  type: string
  warehouseId: Types.ObjectId
  defaultSourceLocationId?: Types.ObjectId
  defaultDestLocationId?: Types.ObjectId
  sequencePrefix: string
  returnOperationTypeId?: Types.ObjectId
  createBackorder: string
  reservationMethod: string
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const operationTypeSchema = new Schema<IOperationType>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['incoming', 'outgoing', 'internal'],
    },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    defaultSourceLocationId: { type: Schema.Types.ObjectId, ref: 'StockLocation' },
    defaultDestLocationId: { type: Schema.Types.ObjectId, ref: 'StockLocation' },
    sequencePrefix: { type: String, required: true },
    returnOperationTypeId: { type: Schema.Types.ObjectId, ref: 'OperationType' },
    createBackorder: {
      type: String,
      default: 'ask',
      enum: ['ask', 'always', 'never'],
    },
    reservationMethod: {
      type: String,
      default: 'at_confirm',
      enum: ['at_confirm', 'manual'],
    },
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

operationTypeSchema.plugin(tenantPlugin)
operationTypeSchema.index({ orgId: 1, code: 1 }, { unique: true })
operationTypeSchema.index({ orgId: 1, warehouseId: 1 })

export const OperationType = model<IOperationType>('OperationType', operationTypeSchema)
