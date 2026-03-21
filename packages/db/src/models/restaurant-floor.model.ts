import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IRestaurantTable {
  number: number
  name: string
  seats: number
  positionX: number
  positionY: number
  shape: string                   // square, round, rectangle
  state: string                   // available, occupied, reserved
  currentOrderId?: Types.ObjectId
}

export interface IRestaurantFloor extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  tables: IRestaurantTable[]
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const tableSchema = new Schema(
  {
    number: { type: Number, required: true },
    name: { type: String, required: true },
    seats: { type: Number, required: true, min: 1 },
    positionX: { type: Number, default: 0 },
    positionY: { type: Number, default: 0 },
    shape: { type: String, default: 'square', enum: ['square', 'round', 'rectangle'] },
    state: { type: String, default: 'available', enum: ['available', 'occupied', 'reserved'] },
    currentOrderId: { type: Schema.Types.ObjectId, ref: 'POSTransaction' },
  },
  { _id: false },
)

const restaurantFloorSchema = new Schema<IRestaurantFloor>(
  {
    name: { type: String, required: true },
    tables: [tableSchema],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

restaurantFloorSchema.plugin(tenantPlugin)
restaurantFloorSchema.index({ orgId: 1, name: 1 })

export const RestaurantFloor = model<IRestaurantFloor>('RestaurantFloor', restaurantFloorSchema)
