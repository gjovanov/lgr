import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IBOMMaterial {
  productId: Types.ObjectId
  quantity: number
  unit: string
  wastagePercent: number
  cost: number
  notes?: string
}

export interface IBillOfMaterials extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  productId: Types.ObjectId
  name: string
  version: string
  status: string
  materials: IBOMMaterial[]
  laborHours: number
  laborCostPerHour: number
  overheadCost: number
  totalMaterialCost: number
  totalCost: number
  instructions?: string
  createdAt: Date
  updatedAt: Date
}

const bomMaterialSchema = new Schema<IBOMMaterial>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    wastagePercent: { type: Number, default: 0 },
    cost: { type: Number, required: true },
    notes: String,
  },
  { _id: false },
)

const billOfMaterialsSchema = new Schema<IBillOfMaterials>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    version: { type: String, required: true },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'active', 'obsolete'],
    },
    materials: [bomMaterialSchema],
    laborHours: { type: Number, required: true },
    laborCostPerHour: { type: Number, required: true },
    overheadCost: { type: Number, required: true, default: 0 },
    totalMaterialCost: { type: Number, required: true, default: 0 },
    totalCost: { type: Number, required: true, default: 0 },
    instructions: String,
  },
  { timestamps: true },
)

billOfMaterialsSchema.plugin(tenantPlugin)
billOfMaterialsSchema.index({ orgId: 1, productId: 1 })

export const BillOfMaterials = model<IBillOfMaterials>('BillOfMaterials', billOfMaterialsSchema)
