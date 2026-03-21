import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IEquipment extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  categoryId?: Types.ObjectId
  location?: string
  assignedToId?: Types.ObjectId
  serialNumber?: string
  purchaseDate?: Date
  warrantyExpiry?: Date
  maintenanceTeamId?: Types.ObjectId
  expectedMTBF?: number
  mttr?: number
  nextPreventiveDate?: Date
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const equipmentSchema = new Schema<IEquipment>(
  {
    name: { type: String, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'ProductCategory' },
    location: String,
    assignedToId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    serialNumber: String,
    purchaseDate: Date,
    warrantyExpiry: Date,
    maintenanceTeamId: { type: Schema.Types.ObjectId, ref: 'Department' },
    expectedMTBF: Number,
    mttr: Number,
    nextPreventiveDate: Date,
    notes: String,
  },
  { timestamps: true },
)

equipmentSchema.plugin(tenantPlugin)
equipmentSchema.index({ orgId: 1, serialNumber: 1 })
equipmentSchema.index({ orgId: 1, assignedToId: 1 })

export const Equipment = model<IEquipment>('Equipment', equipmentSchema)
