import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IEmployeeDocument extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  type: string
  title: string
  description?: string
  fileId: Types.ObjectId
  validFrom?: Date
  validTo?: Date
  isConfidential: boolean
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const employeeDocumentSchema = new Schema<IEmployeeDocument>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: {
      type: String,
      required: true,
      enum: ['contract', 'amendment', 'id_copy', 'certificate', 'evaluation', 'warning', 'other'],
    },
    title: { type: String, required: true },
    description: String,
    fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    validFrom: Date,
    validTo: Date,
    isConfidential: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

employeeDocumentSchema.plugin(tenantPlugin)
employeeDocumentSchema.index({ orgId: 1, employeeId: 1, type: 1 })

export const EmployeeDocument = model<IEmployeeDocument>('EmployeeDocument', employeeDocumentSchema)
