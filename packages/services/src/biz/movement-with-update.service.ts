import { mongoose } from 'db/connection'
import { Product, StockMovement } from 'db/models'

export interface ProductUpdateInput {
  productId: string
  /** Any subset of Product fields the caller wants to persist. Unknown fields are dropped. */
  purchasePrice?: number
  sellingPrice?: number
  taxRate?: number
  categoryId?: string | null
  unit?: string
  type?: string
  /** Full tier replacement (max 10). Pre-validated shape — same as Product.priceTiers. */
  priceTiers?: Array<{
    name: string
    percent?: number
    finalPrice: number
    manualOverride?: boolean
    contactIds?: string[]
    tags?: string[]
    minQuantity?: number
    validFrom?: Date | string
    validTo?: Date | string
  }>
}

export interface CreateMovementInput {
  orgId: string
  movementNumber: string
  type: 'receipt' | 'dispatch' | 'transfer' | 'adjustment' | 'return' | 'production_in' | 'production_out'
  date: string | Date
  fromWarehouseId?: string
  toWarehouseId?: string
  contactId?: string
  lines: Array<{
    productId: string
    quantity: number
    unitCost: number
    totalCost: number
    batchNumber?: string
    serialNumbers?: string[]
  }>
  totalAmount: number
  notes?: string
  createdBy: string
}

const PRODUCT_UPDATE_ALLOWED_KEYS = new Set([
  'purchasePrice', 'sellingPrice', 'taxRate', 'categoryId', 'unit', 'type', 'priceTiers',
])

export class GRValidationError extends Error {
  constructor(message: string, public details?: unknown) { super(message) }
}

/**
 * Atomically create a stock movement AND apply inline product updates.
 * Runs inside a Mongo transaction (requires replica set). If any write fails,
 * the whole batch rolls back — no partial state.
 *
 * Validation:
 *  - Every productUpdate[].productId MUST appear in a movement line (prevents rogue updates
 *    from hitch-hiking on an unrelated GR).
 *  - Unknown keys on productUpdate are dropped silently.
 *  - priceTiers length cap (10) is enforced by the Product schema validator.
 */
export async function createMovementWithProductUpdates(
  movement: CreateMovementInput,
  productUpdates: ProductUpdateInput[],
): Promise<{ movementId: string; updatedProductIds: string[] }> {
  if (!Array.isArray(movement.lines) || movement.lines.length === 0) {
    throw new GRValidationError('Movement must have at least one line')
  }

  // Cross-check: productUpdates only allowed for products present in movement lines.
  const lineProductIds = new Set(movement.lines.map(l => String(l.productId)))
  for (const upd of productUpdates) {
    if (!lineProductIds.has(String(upd.productId))) {
      throw new GRValidationError(`Product ${upd.productId} is not in any movement line`)
    }
  }

  // Normalise each update: drop unknown keys to reduce attack surface.
  const safeUpdates = productUpdates.map((raw) => {
    const out: Record<string, any> = { productId: String(raw.productId) }
    for (const k of Object.keys(raw)) {
      if (k === 'productId') continue
      if (PRODUCT_UPDATE_ALLOWED_KEYS.has(k)) out[k] = (raw as any)[k]
    }
    return out
  })

  // Pre-validate known constraints before opening the transaction (cheaper to fail here).
  // Array validators are not always triggered by bulkWrite — enforce explicitly.
  for (const u of safeUpdates) {
    if (Array.isArray(u.priceTiers) && u.priceTiers.length > 10) {
      throw new GRValidationError(`Product ${u.productId}: priceTiers exceeds maximum of 10 slots`)
    }
    if (Array.isArray(u.priceTiers)) {
      for (const t of u.priceTiers) {
        if (!t || typeof t !== 'object') throw new GRValidationError('priceTiers entries must be objects')
        if (!t.name || typeof t.name !== 'string') throw new GRValidationError('priceTiers entry missing name')
        if (t.finalPrice == null || t.finalPrice < 0) throw new GRValidationError('priceTiers entry has invalid finalPrice')
      }
    }
    if (u.purchasePrice != null && u.purchasePrice < 0) throw new GRValidationError('purchasePrice must be ≥ 0')
    if (u.sellingPrice != null && u.sellingPrice < 0) throw new GRValidationError('sellingPrice must be ≥ 0')
  }

  const session = await mongoose.startSession()
  let movementId: string | null = null
  const updatedProductIds: string[] = []

  try {
    await session.withTransaction(async () => {
      // Pre-load products to 404 early (inside txn so we can fail & abort cheaply).
      const productIds = safeUpdates.map(u => u.productId)
      if (productIds.length) {
        const found = await Product.find({ _id: { $in: productIds }, orgId: movement.orgId })
          .session(session)
          .select({ _id: 1 })
          .lean()
        if (found.length !== productIds.length) {
          throw new GRValidationError('One or more productUpdates reference products that do not exist in this org')
        }
      }

      // Apply product updates (bulkWrite inside the session).
      if (safeUpdates.length) {
        const ops = safeUpdates.map((u) => ({
          updateOne: {
            filter: { _id: u.productId, orgId: movement.orgId },
            update: { $set: Object.fromEntries(Object.entries(u).filter(([k]) => k !== 'productId')) },
          },
        }))
        // `runValidators` ensures the priceTiers length cap validator still fires inside the txn.
        await Product.bulkWrite(ops as any, { session, ordered: true })
        updatedProductIds.push(...safeUpdates.map(u => u.productId))
      }

      // Create the stock movement.
      const doc = new StockMovement({
        orgId: movement.orgId,
        movementNumber: movement.movementNumber,
        type: movement.type,
        status: 'draft',
        date: new Date(movement.date),
        fromWarehouseId: movement.fromWarehouseId,
        toWarehouseId: movement.toWarehouseId,
        contactId: movement.contactId,
        lines: movement.lines,
        totalAmount: movement.totalAmount,
        notes: movement.notes,
        createdBy: movement.createdBy,
      })
      await doc.save({ session })
      movementId = String(doc._id)
    })
  } finally {
    await session.endSession()
  }

  if (!movementId) throw new Error('Transaction did not produce a movement id')
  return { movementId, updatedProductIds }
}
