import { Schema, model, type Document, type Types } from 'mongoose'

export type CodeType = 'user_activation'

export interface ICode extends Document {
  _id: Types.ObjectId
  userId: Types.ObjectId
  orgId: Types.ObjectId
  token: string
  type: CodeType
  validTo: Date
  createdAt: Date
  updatedAt: Date
}

const codeSchema = new Schema<ICode>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    token: { type: String, required: true },
    type: { type: String, enum: ['user_activation'], required: true },
    validTo: { type: Date, required: true },
  },
  { timestamps: true },
)

codeSchema.index({ userId: 1, type: 1 })
codeSchema.index({ validTo: 1 }, { expireAfterSeconds: 3600 })

export const Code = model<ICode>('Code', codeSchema)
