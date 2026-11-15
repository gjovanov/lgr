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
  /**
   * On the year=0 sentinel doc of a series: its numbers carry no year and never start again on
   * 1 January (`INV-3000004106`). Such a series COUNTS on this row (`lastNumber`), and each number
   * drawn is written to its year's row as well, which is what the legal mark and a promotion's last
   * numbers read (`sequence.service#getNextContinuousNumber`).
   */
  continuous?: boolean
}

const sequenceSchema = new Schema<ISequence>(
  {
    prefix: { type: String, required: true },
    year: { type: Number, required: true },
    lastNumber: { type: Number, required: true, default: 0 },
    displayPrefix: String,
    continuous: Boolean,
  },
  { timestamps: true },
)

sequenceSchema.plugin(tenantPlugin)
sequenceSchema.index({ orgId: 1, prefix: 1, year: 1 }, { unique: true })

replicate(sequenceSchema, { class: 'R' })

export const Sequence = model<ISequence>('Sequence', sequenceSchema)
