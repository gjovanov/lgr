import type { ClientSession } from 'mongoose'
import { MAX_PRICE_TIERS } from 'config/constants'
import { Product } from 'db/models'

/** One price tier an update changes: its name, and the fields it sets on it. */
export interface ProductUpdateTier {
  name: string
  percent?: number
  finalPrice: number
  manualOverride?: boolean
  contactIds?: string[]
  tags?: string[]
  minQuantity?: number
  validFrom?: Date | string
  validTo?: Date | string
}

export interface ProductUpdateInput {
  productId: string
  /** Any subset of Product fields the caller wants to persist. Unknown fields are dropped. */
  purchasePrice?: number
  sellingPrice?: number
  taxRate?: number
  categoryId?: string | null
  unit?: string
  type?: string
  /**
   * The tiers this update changes — merged BY NAME into what the product holds when it is written
   * (`mergeTiersByName`), never a replacement of its list: a named tier takes the fields given
   * for it and keeps every other, its filters above all; a name the product lacks is added; a
   * tier not named is left as it is.
   */
  priceTiers?: ProductUpdateTier[]
}

const PRODUCT_UPDATE_ALLOWED_KEYS = new Set([
  'purchasePrice', 'sellingPrice', 'taxRate', 'categoryId', 'unit', 'type', 'priceTiers',
])

/** The numeric fields: a value that is not a number would fail the write as a cast error, a 500. */
const NUMERIC_KEYS = ['purchasePrice', 'sellingPrice', 'taxRate'] as const

export class GRValidationError extends Error {
  constructor(message: string, public details?: unknown) { super(message) }
}

/**
 * „Цена1" and „Цена 1" name one slot (an import's wrapped heading), as the Products list and its
 * sort read them (`product-price-columns.ts`, `product-tier-sort.ts`). Case is kept.
 */
export function tierKey(name: unknown): string {
  return String(name ?? '').replace(/\s+/g, '')
}

/** What an update may set on a tier. Its name is how it is found, and is never rewritten. */
const TIER_FIELDS = ['percent', 'finalPrice', 'manualOverride', 'contactIds', 'tags', 'minQuantity', 'validFrom', 'validTo'] as const

/**
 * Merge `changes` into `current` by tier name (the 2026-08-29 doc-import rule, `persist-movement.ts`
 * `applyDeliveredPrices`): a tier the product holds takes the fields a change gives and keeps the
 * rest — the contact, tag, quantity and date filters a form does not even show; a name it does not
 * hold is added; tiers no change names are kept as they are, in their order.
 *
 * The forms used to send the product's whole tier list as they had read it, and the write replaced
 * the list with it: every filter the form did not copy was erased, a product with fewer slots was
 * padded with „Price N" ones, and a price changed elsewhere since the form opened was put back.
 */
export function mergeTiersByName(current: any[] | null | undefined, changes: ProductUpdateTier[]): any[] {
  const out = (current || []).map(t => ({ ...t }))
  for (const change of changes) {
    const key = tierKey(change.name)
    let tier = out.find(t => tierKey(t.name) === key)
    if (!tier) {
      tier = { name: String(change.name).trim(), percent: 0, finalPrice: 0, manualOverride: false, contactIds: [], tags: [] }
      out.push(tier)
    }
    for (const f of TIER_FIELDS) {
      if ((change as any)[f] !== undefined) tier[f] = (change as any)[f]
    }
  }
  return out
}

/**
 * Validate + normalise inline product updates before a transaction is opened.
 *  - Every update must target a product present in `allowedProductIds` (prevents rogue updates
 *    from hitch-hiking on an unrelated document).
 *  - Unknown keys are dropped silently to reduce attack surface.
 *  - priceTiers shape and the slot cap are enforced explicitly (bulkWrite does not always
 *    trigger array validators); the cap holds again for the merged list (`applyProductUpdates`).
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
    if ('priceTiers' in u && !Array.isArray(u.priceTiers)) throw new GRValidationError('priceTiers must be a list of tiers')
    if (Array.isArray(u.priceTiers) && u.priceTiers.length > MAX_PRICE_TIERS) {
      throw new GRValidationError(`Product ${u.productId}: priceTiers exceeds maximum of ${MAX_PRICE_TIERS} slots`)
    }
    if (Array.isArray(u.priceTiers)) {
      for (const t of u.priceTiers) {
        if (!t || typeof t !== 'object') throw new GRValidationError('priceTiers entries must be objects')
        if (!t.name || typeof t.name !== 'string') throw new GRValidationError('priceTiers entry missing name')
        if (t.finalPrice == null || !Number.isFinite(Number(t.finalPrice)) || t.finalPrice < 0) {
          throw new GRValidationError('priceTiers entry has invalid finalPrice')
        }
      }
    }
    for (const k of NUMERIC_KEYS) {
      if (u[k] != null && !Number.isFinite(Number(u[k]))) throw new GRValidationError(`${k} must be a number`)
    }
    if (u.purchasePrice != null && u.purchasePrice < 0) throw new GRValidationError('purchasePrice must be ≥ 0')
    if (u.sellingPrice != null && u.sellingPrice < 0) throw new GRValidationError('sellingPrice must be ≥ 0')
  }

  return safeUpdates
}

/**
 * Apply sanitized product updates inside an open transaction session.
 *
 * One write per product: two lines of one article fold into one update, in line order (they
 * would otherwise each merge their tiers into the same stale read, and the second would undo the
 * first). The tiers merge by name into the product as it is read in this session.
 *
 * Verifies all products exist in the org (aborting the transaction on a miss), then bulk-writes.
 * Returns the ids of the updated products.
 */
export async function applyProductUpdates(
  session: ClientSession,
  orgId: string,
  safeUpdates: Array<Record<string, any>>,
): Promise<string[]> {
  if (!safeUpdates.length) return []

  const byProduct = new Map<string, Record<string, any>>()
  for (const u of safeUpdates) {
    const acc = byProduct.get(u.productId) ?? {}
    for (const [k, v] of Object.entries(u)) {
      if (k === 'productId') continue
      acc[k] = k === 'priceTiers' ? [...(acc.priceTiers || []), ...(v as any[])] : v
    }
    byProduct.set(u.productId, acc)
  }

  const productIds = [...byProduct.keys()]
  const found = await Product.find({ _id: { $in: productIds }, orgId })
    .session(session)
    .select({ _id: 1, priceTiers: 1 })
    .lean()
  if (found.length !== productIds.length) {
    throw new GRValidationError('One or more productUpdates reference products that do not exist in this org')
  }
  const tiersOf = new Map(found.map((p: any) => [String(p._id), p.priceTiers || []]))

  const ops: any[] = []
  for (const [productId, set] of byProduct) {
    if (Array.isArray(set.priceTiers)) {
      const merged = mergeTiersByName(tiersOf.get(productId), set.priceTiers)
      if (merged.length > MAX_PRICE_TIERS) {
        throw new GRValidationError(`Product ${productId}: its price tiers would exceed the maximum of ${MAX_PRICE_TIERS} slots`)
      }
      set.priceTiers = merged
    }
    if (!Object.keys(set).length) continue
    ops.push({ updateOne: { filter: { _id: productId, orgId }, update: { $set: set } } })
  }
  if (!ops.length) return []
  await Product.bulkWrite(ops, { session, ordered: true })
  return ops.map(op => String(op.updateOne.filter._id))
}
