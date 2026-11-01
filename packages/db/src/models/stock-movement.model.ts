import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface ICostAllocation {
  costLayerId: Types.ObjectId
  quantity: number
  unitCost: number
  totalCost: number
}

export interface IStockMovementLine {
  productId: Types.ObjectId
  quantity: number
  unitCost: number
  totalCost: number
  batchNumber?: string
  expiryDate?: Date
  serialNumbers?: string[]
  costAllocations?: ICostAllocation[]
  resolvedUnitCost?: number
  costingMethod?: string
}

export interface IStockMovement extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  movementNumber: string
  type: string
  status: string
  date: Date
  fromWarehouseId?: Types.ObjectId
  toWarehouseId?: Types.ObjectId
  contactId?: Types.ObjectId
  invoiceId?: Types.ObjectId
  productionOrderId?: Types.ObjectId
  lines: IStockMovementLine[]
  totalAmount: number
  /**
   * The source document this movement was booked from, as its file stem —
   * `stokrazp_3000016317`, `sklrazp_0000012698`. It used to live only inside `notes`,
   * where nothing could filter, join or display it.
   */
  reference?: string
  notes?: string
  journalEntryId?: Types.ObjectId
  /** FR-04: bidirectional link to the InventoryCount this adjustment belongs to. */
  inventoryCountId?: Types.ObjectId
  /**
   * FR-21.4: a record of goods some other movement already moved, kept for the history only. The
   * `POS-OUT` session batch dispatches were these: written `completed` without `confirmMovement`,
   * so they never changed stock, while every POS sale had already moved its goods with its own
   * dispatch. Readers that sum movements (SUPTO 18.8, FR-07, FR-11.7c) skip a record-only one.
   */
  recordOnly?: boolean
  /**
   * The mirror that took this movement's stock back when its document was removed (Files rollback,
   * `reverseMovement`). The movement itself stays `completed`: it did happen. But a receipt rolled
   * back holds no goods any more, so no bill pays for it (#168).
   */
  reversedBy?: Types.ObjectId
  reversedAt?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    movementNumber: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out'],
    },
    status: { type: String, required: true, default: 'draft', enum: ['draft', 'confirmed', 'completed', 'cancelled'] },
    date: { type: Date, default: Date.now },
    fromWarehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    toWarehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    productionOrderId: { type: Schema.Types.ObjectId, ref: 'ProductionOrder' },
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        quantity: { type: Number, required: true },
        unitCost: { type: Number, required: true },
        totalCost: { type: Number, required: true },
        batchNumber: String,
        expiryDate: Date,
        serialNumbers: [String],
        costAllocations: [
          {
            costLayerId: { type: Schema.Types.ObjectId, ref: 'CostLayer' },
            quantity: Number,
            unitCost: Number,
            totalCost: Number,
          },
        ],
        resolvedUnitCost: Number,
        costingMethod: { type: String, enum: ['wac', 'fifo', 'lifo', 'fefo', 'standard'] },
        // What a goods receipt DELIVERED for this product (Цена + the Цена1..Цена5 tiers off
        // the стокова разписка). Applied to the product master AND kept here, so reopening the
        // movement shows "With product update" with the prices it actually carried.
        productUpdate: { type: Schema.Types.Mixed },
        priceTiers: [{ type: Schema.Types.Mixed }],
      },
    ],
    totalAmount: { type: Number, default: 0 },
    reference: { type: String, trim: true },
    notes: String,
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    // FR-04: set on adjustments born from an inventory count AND on counts auto-created
    // from a manual adjustment — the pair is always linked both ways.
    inventoryCountId: { type: Schema.Types.ObjectId, ref: 'InventoryCount' },
    recordOnly: Boolean,
    reversedBy: { type: Schema.Types.ObjectId, ref: 'StockMovement' },
    reversedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

stockMovementSchema.plugin(tenantPlugin)
stockMovementSchema.index({ orgId: 1, movementNumber: 1 }, { unique: true })
stockMovementSchema.index({ orgId: 1, type: 1, date: -1 })
stockMovementSchema.index({ orgId: 1, 'lines.productId': 1, date: -1 })
/**
 * FR-11.10 (#21): "sales without a stock document" `$lookup`s movements BY invoiceId.
 * Also speeds the pre-existing reverse reads in `invoicing.service.ts`, which were doing
 * this unindexed.
 */
stockMovementSchema.index({ orgId: 1, invoiceId: 1 })
stockMovementSchema.index({ orgId: 1, reference: 1 })
stockMovementSchema.index({ movementNumber: 'text', notes: 'text' })

replicate(stockMovementSchema, { class: 'R' })

export const StockMovement = model<IStockMovement>('StockMovement', stockMovementSchema)
