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
  /**
   * #473: the opening amount on the fiscal device, as „служебно въведени" (Н-18 чл. 33 ал. 1). Unset where
   * nothing is owed: no amount, no device that takes it, a session from before this existed. `pending` until
   * the device has it. `serviceInBefore`: the device's `ServIn` as an attempt went out, which is what tells
   * later whether one that lost its answer got there (`opening-float.ts`).
   */
  deviceFloat?: {
    state: 'pending' | 'registered'
    deviceNumber?: string
    serviceInBefore?: number
    registeredAt?: Date
    error?: string
  }
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
  /**
   * Cash on delivery: a courier owes it, so it is never in the drawer. The close shows it as
   * expected, nobody counts it, and it stays out of expected cash.
   */
  totalCashOnDelivery: number
  transactionCount: number
  /**
   * FR-9.1 — what the operator counted, per method, against what the system expected.
   * `closingBalance`/`expectedBalance`/`difference` keep their cash-only meaning for
   * backward compatibility with the legacy single-number close. A `cash_on_delivery` line carries
   * `expected` only: there is nothing at the till to count.
   */
  closingBreakdown?: { method: string; expected: number; counted?: number; difference?: number }[]
  /**
   * Whether the fiscal day was closed on the device. `skipped` = no device configured, or an
   * admin explicitly bypassed. `failed` = the device was reachable-but-broken; the session
   * is NOT closed in that case.
   */
  fiscalStatus?: 'closed' | 'skipped' | 'failed'
  fiscalError?: string
  zReportNumber?: string
  /**
   * The Z's own answer, as its driver returned it: the raw text and what it read of it. The device's words,
   * kept for a person to hold against LGR's. A driver with no figures leaves none.
   */
  zReport?: { raw?: string; closure?: string; fmTotal?: number; turnover?: { group: string; amount: number }[] }
  fiscalClosedAt?: Date
  /** The device actually used — a warehouse may have more than one. */
  fiscalDeviceId?: Types.ObjectId
  /**
   * The session's own figures as its close printed them, after the Z-report (`session-report.ts`),
   * kept for a reprint; when it printed, or why it did not.
   */
  report?: Record<string, unknown>
  reportPrintedAt?: Date
  reportError?: string
  journalEntryId?: Types.ObjectId
  batchMovementId?: Types.ObjectId
  // ── Idempotency (FR-20.37, #155) ──
  /** The `Idempotency-Key` that opened the session, and the hash of that request. */
  clientKey?: string
  requestHash?: string
  /** The key and request hash that closed it, so a retried close returns the close. */
  closeClientKey?: string
  closeRequestHash?: string
  /** A close running its Z holds the session until then (`closing_control`). Past it, the process died. */
  closeLeaseUntil?: Date
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
    deviceFloat: {
      type: new Schema(
        {
          state: { type: String, enum: ['pending', 'registered'], required: true },
          deviceNumber: String,
          serviceInBefore: Number,
          registeredAt: Date,
          error: String,
        },
        { _id: false },
      ),
      required: false,
    },
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
    totalCashOnDelivery: { type: Number, required: true, default: 0 },
    transactionCount: { type: Number, required: true, default: 0 },
    closingBreakdown: [{
      method: { type: String, required: true },
      expected: { type: Number, required: true },
      counted: Number,
      difference: Number,
    }],
    fiscalStatus: { type: String, enum: ['closed', 'skipped', 'failed'] },
    fiscalError: String,
    zReportNumber: String,
    zReport: {
      type: new Schema(
        {
          raw: String,
          closure: String,
          fmTotal: Number,
          turnover: { type: [new Schema({ group: String, amount: Number }, { _id: false })], default: undefined },
        },
        { _id: false },
      ),
      required: false,
    },
    fiscalClosedAt: Date,
    fiscalDeviceId: { type: Schema.Types.ObjectId, ref: 'FiscalDevice' },
    cashCountLines: [{
      denomination: { type: Number, required: true },
      quantity: { type: Number, required: true },
    }],
    notes: String,
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    batchMovementId: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
    report: Schema.Types.Mixed,
    reportPrintedAt: Date,
    reportError: String,
    clientKey: String,
    requestHash: String,
    closeClientKey: String,
    closeRequestHash: String,
    closeLeaseUntil: Date,
  },
  { timestamps: true },
)

posSessionSchema.plugin(tenantPlugin)
posSessionSchema.index({ orgId: 1, cashierId: 1, openedAt: -1 })
// FR-23: every `/send`, `/payments` and `/receipt` asks for whoever's open session, and with none open
// the index above fetches every session they ever had, each with its stored report.
posSessionSchema.index({ orgId: 1, cashierId: 1, openedAt: -1 }, { name: 'open_session_of_cashier', partialFilterExpression: { status: 'open' } })
posSessionSchema.index(
  { orgId: 1, clientKey: 1 },
  { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } },
)

replicate(posSessionSchema, { class: 'R' })

export const POSSession = model<IPOSSession>('POSSession', posSessionSchema)
