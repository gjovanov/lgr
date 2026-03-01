import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IWarehouseAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface IWarehouse extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code: string
  address?: IWarehouseAddress | string
  type: string
  manager?: string
  managerId?: Types.ObjectId
  isDefault: boolean
  isActive: boolean
  tags?: string[]
  createdAt: Date
  updatedAt: Date
}

const warehouseSchema = new Schema<IWarehouse>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    address: {
      street: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
    },
    type: { type: String, required: true, enum: ['warehouse', 'store', 'production', 'transit'] },
    manager: String,
    managerId: { type: Schema.Types.ObjectId, ref: 'User' },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    tags: [String],
  },
  { timestamps: true },
)

warehouseSchema.plugin(tenantPlugin)
warehouseSchema.index({ orgId: 1, code: 1 }, { unique: true })
warehouseSchema.index({ orgId: 1, tags: 1 })

export const Warehouse = model<IWarehouse>('Warehouse', warehouseSchema)
