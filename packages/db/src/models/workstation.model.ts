import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IWorkstation extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  code: string
  name: string
  warehouseId: Types.ObjectId
  fiscalDeviceId?: Types.ObjectId
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const workstationSchema = new Schema<IWorkstation>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    fiscalDeviceId: { type: Schema.Types.ObjectId, ref: 'FiscalDevice' },
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

workstationSchema.plugin(tenantPlugin)
workstationSchema.index({ orgId: 1, code: 1 }, { unique: true })
workstationSchema.index({ orgId: 1, warehouseId: 1 })

export const Workstation = model<IWorkstation>('Workstation', workstationSchema)
