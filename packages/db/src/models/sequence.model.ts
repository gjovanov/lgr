import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ISequence extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  prefix: string
  year: number
  lastNumber: number
}

const sequenceSchema = new Schema<ISequence>(
  {
    prefix: { type: String, required: true },
    year: { type: Number, required: true },
    lastNumber: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
)

sequenceSchema.plugin(tenantPlugin)
sequenceSchema.index({ orgId: 1, prefix: 1, year: 1 }, { unique: true })

export const Sequence = model<ISequence>('Sequence', sequenceSchema)
