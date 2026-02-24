import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPipelineStage {
  name: string
  order: number
  probability: number
  color: string
}

export interface IPipeline extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  stages: IPipelineStage[]
  isDefault: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const pipelineStageSchema = new Schema<IPipelineStage>(
  {
    name: { type: String, required: true },
    order: { type: Number, required: true },
    probability: { type: Number, required: true },
    color: { type: String, required: true },
  },
  { _id: false },
)

const pipelineSchema = new Schema<IPipeline>(
  {
    name: { type: String, required: true },
    stages: [pipelineStageSchema],
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

pipelineSchema.plugin(tenantPlugin)
pipelineSchema.index({ orgId: 1, name: 1 }, { unique: true })

export const Pipeline = model<IPipeline>('Pipeline', pipelineSchema)
