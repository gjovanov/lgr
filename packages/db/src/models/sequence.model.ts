import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface ISequence extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  prefix: string
  year: number
  lastNumber: number
  /** Optional display override. When set on the year=0 sentinel doc for a given prefix,
   * future allocations use this string as the formatted prefix instead of the canonical key. */
  displayPrefix?: string
}

const sequenceSchema = new Schema<ISequence>(
  {
    prefix: { type: String, required: true },
    year: { type: Number, required: true },
    lastNumber: { type: Number, required: true, default: 0 },
    displayPrefix: String,
  },
  { timestamps: true },
)

sequenceSchema.plugin(tenantPlugin)
sequenceSchema.index({ orgId: 1, prefix: 1, year: 1 }, { unique: true })

replicate(sequenceSchema, { class: 'R' })

export const Sequence = model<ISequence>('Sequence', sequenceSchema)
