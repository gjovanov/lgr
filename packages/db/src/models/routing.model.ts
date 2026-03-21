import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IRoutingStep {
  sequence: number
  name: string
  workCenterId: Types.ObjectId
  durationMinutes: number
  description?: string
}

export interface IRouting extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  productId?: Types.ObjectId       // Finished product
  bomId?: Types.ObjectId           // Linked BOM
  steps: IRoutingStep[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const routingStepSchema = new Schema(
  {
    sequence: { type: Number, required: true },
    name: { type: String, required: true },
    workCenterId: { type: Schema.Types.ObjectId, ref: 'WorkCenter', required: true },
    durationMinutes: { type: Number, required: true, min: 0 },
    description: String,
  },
  { _id: false },
)

const routingSchema = new Schema<IRouting>(
  {
    name: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    bomId: { type: Schema.Types.ObjectId, ref: 'BillOfMaterials' },
    steps: [routingStepSchema],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

routingSchema.plugin(tenantPlugin)
routingSchema.index({ orgId: 1, productId: 1 })
routingSchema.index({ orgId: 1, bomId: 1 })

export const Routing = model<IRouting>('Routing', routingSchema)
