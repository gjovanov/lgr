import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IFiscalDevice extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  deviceNumber: string
  name: string
  manufacturer: string
  connectionType: string
  connectionParams: {
    port?: string
    baudRate?: number
    ip?: string
    tcpPort?: number
    usbPath?: string
  }
  warehouseId: Types.ObjectId
  workstationId?: Types.ObjectId
  status: string
  lastCommunicationAt?: Date
  firmwareVersion?: string
  isActive: boolean
  deactivatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const connectionParamsSchema = new Schema(
  {
    port: String,
    baudRate: { type: Number, default: 115200 },
    ip: String,
    tcpPort: Number,
    usbPath: String,
  },
  { _id: false },
)

const fiscalDeviceSchema = new Schema<IFiscalDevice>(
  {
    deviceNumber: { type: String, required: true },
    name: { type: String, required: true },
    manufacturer: {
      type: String,
      required: true,
      enum: ['datecs', 'daisy', 'tremol', 'incotex'],
    },
    connectionType: {
      type: String,
      required: true,
      enum: ['serial', 'tcp', 'usb'],
    },
    connectionParams: { type: connectionParamsSchema, default: () => ({}) },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    workstationId: { type: Schema.Types.ObjectId, ref: 'Workstation' },
    status: {
      type: String,
      required: true,
      default: 'offline',
      enum: ['online', 'offline', 'error'],
    },
    lastCommunicationAt: Date,
    firmwareVersion: String,
    isActive: { type: Boolean, default: true },
    deactivatedAt: Date,
  },
  { timestamps: true },
)

fiscalDeviceSchema.plugin(tenantPlugin)
fiscalDeviceSchema.index({ orgId: 1, deviceNumber: 1 }, { unique: true })
fiscalDeviceSchema.index({ orgId: 1, warehouseId: 1 })

export const FiscalDevice = model<IFiscalDevice>('FiscalDevice', fiscalDeviceSchema)
