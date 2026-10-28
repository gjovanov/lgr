import { mongoose } from 'db/connection'
import { Org, Product, ProductCategory } from 'db/models'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { createAuditEntry } from './audit-log.service.js'
import { findSeparatorTwins } from './doc-import/matching.js'
import { DEFAULT_CATEGORY, newProductDoc, nextSkuBase } from './doc-import/persist-movement.js'

/**
 * „+ Нов продукт „…"" on a receipt or bill line (FR-22.30, #3).
 *
 * The article search found nothing, so the user creates the article without leaving the document:
 * name, unit, category, VAT, purchase and selling price. It is born exactly as an imported article
 * is (`newProductDoc` — doc-import's creator): the next SKU of the org's sequence, the price tiers
 * of the org's tier template with their tier-name tags. Only what the import hard-codes for regal
 * comes from the org instead: its currency and its default VAT rate.
 *
 * The category defaults to „Общи", where every catalog-new article lands until it is
 * recategorised (`assign-din-tags`). An org that has no such category gets it — the API refuses an
 * article without a category, and the acme-corp demo has no categories at all.
 *
 * ⚠ Never a second copy. A name the catalog already has (or has but for separators, the doc-import
 * twins) is refused with the existing article, which the line can take instead: a fork splits an
 * article's stock across two rows that nothing reconciles (358 twin groups at regal).
 */

export class QuickProductError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'QuickProductError'
  }
}

export interface QuickProductInput {
  name: string
  unit?: string
  /** A category of the org; absent → „Общи". */
  categoryId?: string
  /** Absent → the org's default VAT rate. */
  taxRate?: number
  purchasePrice?: number
  sellingPrice?: number
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** „Общи", the org's landing category — made the first time it is needed. */
async function defaultCategory(orgId: string): Promise<{ _id: unknown; name: string }> {
  const lower = DEFAULT_CATEGORY.toLocaleLowerCase('bg')
  const found: any = await ProductCategory.findOne({ orgId, $or: [{ nameLower: lower }, { name: DEFAULT_CATEGORY }] } as any).lean().exec()
  if (found) return found
  try {
    const created: any = await ProductCategory.create({ orgId, name: DEFAULT_CATEGORY } as any)
    logger.info({ orgId }, `quick-product: created the default category „${DEFAULT_CATEGORY}"`)
    return created.toObject()
  } catch (e: any) {
    // A concurrent create made it first.
    if (e?.code !== 11000) throw e
    return (await ProductCategory.findOne({ orgId, name: DEFAULT_CATEGORY } as any).lean().exec()) as any
  }
}

export async function createQuickProduct(
  orgId: string,
  actor: { id: string },
  input: QuickProductInput,
): Promise<any> {
  const name = String(input.name || '').replace(/\s+/g, ' ').trim()
  if (!name) throw new QuickProductError(422, 'name_required', 'The article needs a name')

  const r = getRepos()
  const existing: any = await Product.findOne({ orgId, nameLower: name.toLocaleLowerCase('bg') } as any)
    .select('_id').lean().exec()
  if (existing) {
    throw new QuickProductError(409, 'product_exists', `„${name}" is already in the catalog`, {
      product: await r.products.findOne({ id: String(existing._id), orgId } as any),
    })
  }
  const twins = await findSeparatorTwins(orgId, name)
  if (twins.length) {
    throw new QuickProductError(409, 'product_exists',
      `„${name}" differs from ${twins.map(t => `${t.sku} „${t.name}"`).join(', ')} only in separators — pick that article`,
      { product: twins.length === 1 ? await r.products.findOne({ id: String(twins[0]._id), orgId } as any) : undefined, twins: twins.length },
    )
  }

  let category: { _id: unknown; name: string }
  if (input.categoryId) {
    const picked: any = mongoose.Types.ObjectId.isValid(input.categoryId)
      ? await ProductCategory.findOne({ orgId, _id: input.categoryId } as any).lean().exec()
      : null
    if (!picked) throw new QuickProductError(422, 'category_not_found', 'Category not found')
    category = picked
  } else {
    category = await defaultCategory(orgId)
  }

  const org: any = await Org.findById(orgId, { settings: 1, slug: 1 }).lean().exec()
  const taxRate = input.taxRate !== undefined && input.taxRate !== null ? num(input.taxRate) : num(org?.settings?.taxConfig?.defaultVatRate)
  const currency = org?.settings?.baseCurrency || 'EUR'
  const cost = Math.max(0, num(input.purchasePrice))
  const selling = input.sellingPrice !== undefined && input.sellingPrice !== null ? Math.max(0, num(input.sellingPrice)) : undefined

  // The SKU continues the org's sequence; two creates at once may draw the same one, and the
  // unique {orgId, sku} index sends the later one round again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { prefix, next, pad } = await nextSkuBase(orgId, org?.slug)
    const sku = `${prefix}-${String(next).padStart(pad, '0')}`
    try {
      const created: any = await Product.create(newProductDoc(orgId, { name, unit: input.unit || 'pcs', cost, selling, tiers: {} }, {
        sku, categoryName: category.name, categoryId: category._id, currency, taxRate,
      }))
      const id = String(created._id)
      createAuditEntry({ orgId, userId: actor.id, action: 'create', module: 'warehouse', entityType: 'product', entityId: id, entityName: name })
      return r.products.findOne({ id, orgId } as any)
    } catch (e: any) {
      if (e?.code !== 11000 || !/sku/.test(String(e?.message))) throw e
      logger.warn({ orgId, sku, attempt }, 'quick-product: SKU already taken, retrying')
    }
  }
  throw new QuickProductError(409, 'sku_unavailable', 'Could not allocate the next SKU after 3 attempts')
}
