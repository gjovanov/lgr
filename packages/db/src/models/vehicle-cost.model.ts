import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IVehicleCost extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  vehicleId: Types.ObjectId
  type: string
  amount: number
  date: Date
  vendorId?: Types.ObjectId
  odometer?: number
  description?: string
  isRecurring: boolean
  recurringInterval?: number
  recurringPeriod?: string
  createdAt: Date
  updatedAt: Date
}

const vehicleCostSchema = new Schema<IVehicleCost>(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    type: {
      type: String,
      required: true,
      enum: ['fuel', 'insurance', 'maintenance', 'repair', 'tax', 'toll', 'parking', 'fine', 'other'],
    },
    amount: { type: Number, required: true },
    date: { type: Date, required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    odometer: Number,
    description: String,
    isRecurring: { type: Boolean, default: false },
    recurringInterval: Number,
    recurringPeriod: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'yearly'],
    },
  },
  { timestamps: true },
)

vehicleCostSchema.plugin(tenantPlugin)
vehicleCostSchema.index({ orgId: 1, vehicleId: 1, date: -1 })
vehicleCostSchema.index({ orgId: 1, type: 1 })

export const VehicleCost = model<IVehicleCost>('VehicleCost', vehicleCostSchema)
