import { Schema, model, type Document, type Types } from 'mongoose'

export interface IEmailLog extends Document {
  _id: Types.ObjectId
  creatorId?: Types.ObjectId
  orgId?: Types.ObjectId
  from: string
  to: string
  subject: string
  body: string
  createdAt: Date
  updatedAt: Date
}

const emailLogSchema = new Schema<IEmailLog>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'User' },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org' },
    from: { type: String, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
  },
  { timestamps: true },
)

emailLogSchema.index({ to: 1, createdAt: -1 })

export const EmailLog = model<IEmailLog>('EmailLog', emailLogSchema)
