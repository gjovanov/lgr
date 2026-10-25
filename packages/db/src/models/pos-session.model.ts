import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IPOSSession extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  warehouseId: Types.ObjectId
  cashierId: Types.ObjectId
  sessionNumber: string
  openedAt: Date
  closedAt?: Date
  status: string
  openingBalance: number
  closingBalance?: number
  expectedBalance?: number
  difference?: number
  cashCountLines?: { denomination: number; quantity: number }[]
  notes?: string
  currency: string
  totalSales: number
  totalReturns: number
  totalCash: number
  totalCard: number
  /** FR-9.2: mobile/voucher tenders, which were accepted per transaction but never summed. */
  totalOther: number
  transactionCount: number
  /**
   * FR-9.1 — what the operator counted, per method, against what the system expected.
   * `closingBalance`/`expectedBalance`/`difference` keep their cash-only meaning for
   * backward compatibility with the legacy single-number close.
   */
  closingBreakdown?: { method: string; expected: number; counted: number; difference: number }[]
  /**
   * Whether the fiscal day was closed on the device. `skipped` = no device configured, or an
   * admin explicitly bypassed. `failed` = the device was reachable-but-broken; the session
   * is NOT closed in that case.
   */
  fiscalStatus?: 'closed' | 'skipped' | 'failed'
  fiscalError?: string
  zReportNumber?: string
  fiscalClosedAt?: Date
  /** The device actually used — a warehouse may have more than one. */
  fiscalDeviceId?: Types.ObjectId
  journalEntryId?: Types.ObjectId
  batchMovementId?: Types.ObjectId
  // ── Idempotency (FR-20.37, #155) ──
  /** The `Idempotency-Key` that opened the session, and the hash of that request. */
  clientKey?: string
  requestHash?: string
  /** The key and request hash that closed it, so a retried close returns the close. */
  closeClientKey?: string
  closeRequestHash?: string
  createdAt: Date
  updatedAt: Date
}

const posSessionSchema = new Schema<IPOSSession>(
  {
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionNumber: { type: String, required: true },
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
    status: {
      type: String,
      required: true,
      default: 'open',
      enum: ['opening_control', 'open', 'closing_control', 'closed'],
    },
    openingBalance: { type: Number, required: true },
    closingBalance: Number,
    expectedBalance: Number,
    difference: Number,
    currency: { type: String, default: 'EUR' },
    totalSales: { type: Number, required: true, default: 0 },
    totalReturns: { type: Number, required: true, default: 0 },
    totalCash: { type: Number, required: true, default: 0 },
    totalCard: { type: Number, required: true, default: 0 },
    // Sessions predating this field read as 0, which is exactly right.
    totalOther: { type: Number, required: true, default: 0 },
    transactionCount: { type: Number, required: true, default: 0 },
    closingBreakdown: [{
      method: { type: String, required: true },
      expected: { type: Number, required: true },
      counted: { type: Number, required: true },
      difference: { type: Number, required: true },
    }],
    fiscalStatus: { type: String, enum: ['closed', 'skipped', 'failed'] },
    fiscalError: String,
    zReportNumber: String,
    fiscalClosedAt: Date,
    fiscalDeviceId: { type: Schema.Types.ObjectId, ref: 'FiscalDevice' },
    cashCountLines: [{
      denomination: { type: Number, required: true },
      quantity: { type: Number, required: true },
    }],
    notes: String,
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    batchMovementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
    clientKey: String,
    requestHash: String,
    closeClientKey: String,
    closeRequestHash: String,
  },
  { timestamps: true },
)

posSessionSchema.plugin(tenantPlugin)
posSessionSchema.index({ orgId: 1, cashierId: 1, openedAt: -1 })
posSessionSchema.index(
  { orgId: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } },
)

replicate(posSessionSchema, { class: 'R' })

export const POSSession = model<IPOSSession>('POSSession', posSessionSchema)
