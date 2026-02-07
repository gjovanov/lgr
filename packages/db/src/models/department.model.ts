import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IDepartment extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code: string
  parentId?: Types.ObjectId
  headId?: Types.ObjectId
  description?: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const departmentSchema = new Schema<IDepartment>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Department' },
    headId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    description: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

departmentSchema.plugin(tenantPlugin)
departmentSchema.index({ orgId: 1, code: 1 }, { unique: true })

export const Department = model<IDepartment>('Department', departmentSchema)
