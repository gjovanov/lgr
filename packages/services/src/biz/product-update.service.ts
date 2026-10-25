import type { ClientSession } from 'mongoose'
import { MAX_PRICE_TIERS } from 'config/constants'
import { Product } from 'db/models'

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

const PRODUCT_UPDATE_ALLOWED_KEYS = new Set([
  'purchasePrice', 'sellingPrice', 'taxRate', 'categoryId', 'unit', 'type', 'priceTiers',
])

export class GRValidationError extends Error {
  constructor(message: string, public details?: unknown) { super(message) }
}

/**
 * Validate + normalise inline product updates before a transaction is opened.
 *  - Every update must target a product present in `allowedProductIds` (prevents rogue updates
 *    from hitch-hiking on an unrelated document).
 *  - Unknown keys are dropped silently to reduce attack surface.
 *  - priceTiers shape and the 10-slot cap are enforced explicitly (bulkWrite does not always
 *    trigger array validators).
 */
export function sanitizeProductUpdates(
  productUpdates: ProductUpdateInput[],
  allowedProductIds: Set<string>,
  contextLabel = 'movement',
): Array<Record<string, any>> {
  for (const upd of productUpdates) {
    if (!allowedProductIds.has(String(upd.productId))) {
      throw new GRValidationError(`Product ${upd.productId} is not in any ${contextLabel} line`)
    }
  }

  const safeUpdates = productUpdates.map((raw) => {
    const out: Record<string, any> = { productId: String(raw.productId) }
    for (const k of Object.keys(raw)) {
      if (k === 'productId') continue
      if (PRODUCT_UPDATE_ALLOWED_KEYS.has(k)) out[k] = (raw as any)[k]
    }
    return out
  })

  for (const u of safeUpdates) {
    if (Array.isArray(u.priceTiers) && u.priceTiers.length > MAX_PRICE_TIERS) {
      throw new GRValidationError(`Product ${u.productId}: priceTiers exceeds maximum of ${MAX_PRICE_TIERS} slots`)
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

  return safeUpdates
}

/**
 * Apply sanitized product updates inside an open transaction session.
 * Verifies all products exist in the org (aborting the transaction on a miss), then bulk-writes.
 * Returns the ids of the updated products.
 */
export async function applyProductUpdates(
  session: ClientSession,
  orgId: string,
  safeUpdates: Array<Record<string, any>>,
): Promise<string[]> {
  if (!safeUpdates.length) return []

  const productIds = safeUpdates.map(u => u.productId)
  const found = await Product.find({ _id: { $in: productIds }, orgId })
    .session(session)
    .select({ _id: 1 })
    .lean()
  if (found.length !== productIds.length) {
    throw new GRValidationError('One or more productUpdates reference products that do not exist in this org')
  }

  const ops = safeUpdates.map((u) => ({
    updateOne: {
      filter: { _id: u.productId, orgId },
      update: { $set: Object.fromEntries(Object.entries(u).filter(([k]) => k !== 'productId')) },
    },
  }))
  await Product.bulkWrite(ops as any, { session, ordered: true })
  return safeUpdates.map(u => u.productId)
}
