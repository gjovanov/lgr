import { mongoose } from 'db/connection'
import { StockMovement } from 'db/models'
import { GRValidationError, sanitizeProductUpdates, applyProductUpdates, type ProductUpdateInput } from './product-update.service.js'

export { GRValidationError } from './product-update.service.js'
export type { ProductUpdateInput } from './product-update.service.js'

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

  // Cross-check + normalise before opening the transaction (cheaper to fail here).
  const lineProductIds = new Set(movement.lines.map(l => String(l.productId)))
  const safeUpdates = sanitizeProductUpdates(productUpdates, lineProductIds, 'movement')

  const session = await mongoose.startSession()
  let movementId: string | null = null
  let updatedProductIds: string[] = []

  try {
    await session.withTransaction(async () => {
      updatedProductIds = await applyProductUpdates(session, movement.orgId, safeUpdates)

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

/**
 * Atomically apply a draft-movement edit ($set) AND inline product-master updates.
 * Draft-only (confirmed movements have already touched stock). Mirror of
 * updateInvoiceWithProductUpdates on the invoicing side.
 */
export async function updateMovementWithProductUpdates(params: {
  orgId: string
  movementId: string
  update: Record<string, any>
  productUpdates: ProductUpdateInput[]
}): Promise<{ updatedProductIds: string[] }> {
  const { orgId, movementId, update, productUpdates } = params

  const existing: any = await StockMovement.findOne({ _id: movementId, orgId } as any).lean()
  if (!existing) throw new GRValidationError('Movement not found')
  if (existing.status !== 'draft') throw new GRValidationError('Can only edit draft movements')

  const lines: any[] = (update.lines ?? existing.lines ?? []) as any[]
  const allowedProductIds = new Set<string>(lines.filter(l => l?.productId).map(l => String(l.productId)))
  const safeUpdates = sanitizeProductUpdates(productUpdates, allowedProductIds, 'movement')

  const session = await mongoose.startSession()
  let updatedProductIds: string[] = []

  try {
    await session.withTransaction(async () => {
      updatedProductIds = await applyProductUpdates(session, orgId, safeUpdates)
      await StockMovement.findOneAndUpdate({ _id: movementId, orgId } as any, { $set: update }, { new: true, session })
    })
  } finally {
    await session.endSession()
  }

  return { updatedProductIds }
}
