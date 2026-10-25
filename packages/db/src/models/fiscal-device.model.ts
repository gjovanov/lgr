import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

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
    /**
     * FR-14.27 — which registered desktop owns this device's serial port.
     *
     * ⚠ Set only for `connectionType: 'desktop'`, and it is a **constraint, not a hint**: the
     * native bridge is refused unless the registering desktop is this one (and the device is in
     * that desktop's `fiscalDeviceIds`). Leaving it unset lets any assigned desktop bridge the
     * device, which is what a shop with a spare till wants; pinning it is what a shop with two
     * tills on one counter wants.
     */
    bridgeDesktopId?: Types.ObjectId
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
    bridgeDesktopId: { type: Schema.Types.ObjectId, ref: 'Desktop' },
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
      enum: ['datecs', 'daisy', 'tremol', 'eltrade', 'incotex'],
    },
    connectionType: {
      type: String,
      required: true,
      // ⚠ `desktop` (FR-14.27) is the native bridge: a registered LGR Desktop holds the serial
      // port and relays frames. It is deliberately a SEPARATE value from `browser` rather than a
      // flag on it — one owner per port is the point, and the two bridges must never both be
      // offered the same device (`BRIDGEABLE_CONNECTION_TYPES` in `fiscal-bridge.ts`).
      enum: ['serial', 'tcp', 'usb', 'browser', 'desktop'],
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

replicate(fiscalDeviceSchema, {
  class: 'S',
  // The configuration is the home's; whether the device answers is true only where it is plugged in.
  home: ['deviceNumber', 'name', 'manufacturer', 'connectionType', 'connectionParams', 'warehouseId', 'workstationId', 'firmwareVersion', 'isActive', 'deactivatedAt', 'createdAt', 'updatedAt'],
  global: [],
  node: ['status', 'lastCommunicationAt'],
})

export const FiscalDevice = model<IFiscalDevice>('FiscalDevice', fiscalDeviceSchema)
