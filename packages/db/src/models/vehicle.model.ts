import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IVehicle extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  model: string
  brand: string
  driverId?: Types.ObjectId
  state: string
  acquisitionDate?: Date
  purchaseValue?: number
  fuelType: string
  odometer: number
  nextServiceDate?: Date
  insuranceExpiry?: Date
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const vehicleSchema = new Schema<IVehicle>(
  {
    name: { type: String, required: true },
    model: { type: String, required: true },
    brand: { type: String, required: true },
    driverId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    state: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'in_service', 'out_of_service', 'sold', 'scrapped'],
    },
    acquisitionDate: Date,
    purchaseValue: Number,
    fuelType: {
      type: String,
      required: true,
      enum: ['gasoline', 'diesel', 'electric', 'hybrid', 'lpg', 'cng', 'hydrogen'],
    },
    odometer: { type: Number, required: true, default: 0 },
    nextServiceDate: Date,
    insuranceExpiry: Date,
    notes: String,
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

vehicleSchema.plugin(tenantPlugin)
vehicleSchema.index({ orgId: 1, state: 1 })
vehicleSchema.index({ orgId: 1, driverId: 1 })

export const Vehicle = model<IVehicle>('Vehicle', vehicleSchema)
