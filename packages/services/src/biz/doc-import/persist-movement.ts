/**
 * Writing imported stock documents: create any catalog-new products, then book and confirm
 * the movement.
 *
 * A movement line REQUIRES a productId, so an unmatched row cannot simply be carried as
 * free text the way an invoice line can — it would vanish, and a silently skipped receipt
 * line is permanent stock drift. Hence `createMissingProducts`, which mirrors
 * `receive-new-products`: continue the org's SKU sequence, open the product at the
 * разписка's cost, and build its price tiers with the tier-name tags that make tag-based
 * price resolution work.
 *
 * The movement is created `draft` and immediately confirmed — confirming is the only step
 * that writes stock.
 */
import { Product, ProductCategory, StockMovement } from 'db/models'
import { getRepos } from '../../context.js'
import { confirmMovement } from '../warehouse.service.js'
import { createAuditEntry } from '../audit-log.service.js'
import { buildTiers, repriceTiers, PROTECTED_TIERS } from './map-movement.js'
import { findSeparatorTwins } from './matching.js'
import type { MappedMovement, NewProductDraft } from './types.js'

/** Default markup when a разписка carries a cost but no sale price. */
const DEFAULT_MARKUP = 1.1
/** Where catalog-new import products land until `assign-din-tags` recategorises them. */
const DEFAULT_CATEGORY = 'Общи'

/** Next SKU continuing the org's numeric sequence (max `<PREFIX>-NNNNN` + 1). */
async function nextSkuBase(orgId: string, orgSlug?: string): Promise<{ prefix: string; next: number; pad: number }> {
  const rows: any[] = await Product.find({ orgId } as any, { sku: 1 }).sort({ sku: -1 }).limit(10).lean()
  for (const p of rows) {
    const m = String(p.sku || '').match(/^(.*)-(\d+)$/)
    if (m) return { prefix: m[1], next: parseInt(m[2], 10) + 1, pad: m[2].length }
  }
  const prefix = (orgSlug || 'SKU').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SKU'
  return { prefix, next: 1, pad: 5 }
}

export interface CreatedProduct {
  productId: string
  sku: string
  name: string
  created: boolean
  /** The name the DOCUMENT used. Differs from `name` when a separator twin was reused. */
  requestedName: string
}

/**
 * Create (or reprice) the products a document delivered.
 *
 * Re-running is deliberately not a no-op for PRICES: an already-existing product has its
 * cost and delivered tiers refreshed, while its quantity is booked exactly once by the
 * movement's own marker check. That is how prices get back-filled for deliveries booked
 * before a product carried them.
 */
export async function createMissingProducts(
  orgId: string,
  drafts: NewProductDraft[],
  opts: { orgSlug?: string; categoryName?: string } = {},
): Promise<CreatedProduct[]> {
  if (!drafts.length) return []

  const categoryName = opts.categoryName || DEFAULT_CATEGORY
  const category: any = await ProductCategory.findOne({ orgId, name: categoryName } as any).lean()

  let { prefix, next, pad } = await nextSkuBase(orgId, opts.orgSlug)
  const out: CreatedProduct[] = []

  for (const d of drafts) {
    const lower = d.name.toLocaleLowerCase('bg')
    let existing: any = await Product.findOne({ orgId, nameLower: lower } as any).lean()
    if (!existing) {
      // No row spells it this way. Before adding one, check for a row that differs only in
      // separators: the matcher refuses an AMBIGUOUS name (several such twins) and reports the
      // same `null` as a genuine miss, so without this the refusal would land here and fork the
      // group a third time. ⚠ Several twins is refused outright rather than guessed or dropped —
      // dropping loses the quantity silently, which for a receipt is permanent stock drift.
      const twins = await findSeparatorTwins(orgId, d.name)
      if (twins.length > 1) {
        throw new Error(
          `"${d.name}" matches ${twins.length} catalog products that differ from it only in separators `
          + `(${twins.map(t => `${t.sku} ${JSON.stringify(t.name)}`).join(', ')}). `
          + 'Point the line at one of them, or merge the duplicates — booking it would either pick one '
          + 'at random or add a third copy.',
        )
      }
      if (twins.length === 1) existing = await Product.findOne({ _id: twins[0]._id } as any).lean()
    }
    if (existing) {
      // Already there (created by a concurrent line, or matched loosely): refresh the SALE prices
      // only — the buying price stays put. `selling` is the разписка's „Прод. цена" and is absent
      // on the older narrow layout; falling back to `cost` there would price the goods at what we
      // paid for them, so leave sellingPrice untouched instead.
      const selling = Number(d.selling) || 0
      await Product.updateOne({ _id: existing._id } as any, {
        $set: {
          ...(selling > 0 ? { sellingPrice: selling } : {}),
          priceTiers: repriceTiers(existing.priceTiers, d.tiers, Number(existing.purchasePrice) || 0),
        },
      })
      out.push({ productId: String(existing._id), sku: existing.sku, name: existing.name, created: false, requestedName: d.name })
      continue
    }

    const sku = `${prefix}-${String(next).padStart(pad, '0')}`
    next++
    const selling = d.selling ?? (d.cost > 0 ? +(d.cost * DEFAULT_MARKUP).toFixed(4) : 0)
    const created: any = await Product.create({
      orgId,
      sku,
      name: d.name,
      category: categoryName,
      ...(category ? { categoryId: category._id } : {}),
      type: 'goods',
      unit: d.unit || 'pcs',
      purchasePrice: d.cost,
      sellingPrice: selling,
      currency: 'BGN',
      taxRate: 20,
      trackInventory: true,
      isActive: true,
      priceTiers: buildTiers(d.cost, d.tiers),
    })
    out.push({ productId: String(created._id), sku, name: d.name, created: true, requestedName: d.name })
  }

  return out
}

/** `SM-<year>-NNNNN`, continuing the org's movement sequence. */
async function nextMovementNumber(orgId: string): Promise<string> {
  const r = getRepos()
  const year = new Date().getFullYear()
  const prefix = `SM-${year}-`
  const movements = await r.stockMovements.findMany(
    { orgId, movementNumber: { $regex: `^${prefix}` } } as any,
    { movementNumber: -1 },
  )
  if (!movements.length) return `${prefix}00001`
  const currentNum = parseInt(movements[0].movementNumber.replace(prefix, ''), 10)
  return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
}

export interface PersistMovementResult {
  id: string
  movementNumber: string
  status: string
  createdProducts: CreatedProduct[]
  /** Lines dropped because their product still had no match and creation was declined. */
  droppedLines: string[]
}

/**
 * Write the SALE prices a разписка delivered onto the product master.
 *
 * Shared by two callers, deliberately: the ordinary receipt path below, and the price-only
 * разписка, which has no movement at all. PlusMinus issues those (empty „Кол" throughout, zero
 * footer) for exactly one purpose — to restate prices — and until 2026-10-08 it committed as a
 * total no-op: the mapper computed every `productUpdate` and tier and then dropped the lines on
 * the floor because they could not enter a movement. Four pz documents and two sf ones went by
 * that way, 43 priced lines that never reached the catalog.
 *
 * Receipt-side documents only. A transfer or a write-off out of the warehouse must not reprice
 * anything, which is why the caller checks the family rather than this function assuming it.
 *
 * Returns how many products were written, so a caller with nothing else to report can say it.
 */
export async function applyDeliveredPrices(orgId: string, lines: MappedMovement['lines']): Promise<number> {
  let repriced = 0
  for (const l of lines) {
    if (!l.productId) continue
    const set: Record<string, any> = { ...(l.productUpdate || {}) }
    // purchasePrice is never written from a разписка — guard the staged payload too, so an
    // analysis produced before this rule (or an API client) cannot reintroduce it.
    delete set.purchasePrice
    if (l.priceTiers?.length) {
      // Overlay by NAME onto what the product holds now. Assigning the staged array outright
      // would carry that array's cost slots over the product's, and a stale analysis would put
      // the разписка's Цена back into Доставна цена — the exact write this rule removes.
      const prod: any = await Product.findOne({ orgId, _id: l.productId } as any, { priceTiers: 1 }).lean()
      const slots = (prod?.priceTiers?.length ? prod.priceTiers : buildTiers(0, {})).map((t: any) => ({ ...t }))
      for (const staged of l.priceTiers as any[]) {
        if (!staged?.name || PROTECTED_TIERS.has(staged.name)) continue
        const t = slots.find((x: any) => x.name === staged.name)
        if (!t || !(Number(staged.finalPrice) > 0)) continue
        Object.assign(t, {
          finalPrice: Number(staged.finalPrice),
          percent: Number(staged.percent) || 0,
          manualOverride: true,
          tags: t.tags?.length ? t.tags : [staged.name],
          contactIds: t.contactIds || [],
        })
      }
      set.priceTiers = slots
    }
    if (Object.keys(set).length) {
      await Product.updateOne({ orgId, _id: l.productId } as any, { $set: set })
      repriced++
    }
  }
  return repriced
}

export async function persistMovement(
  orgId: string,
  userId: string,
  mapped: MappedMovement,
  opts: { createMissingProducts?: boolean; confirm?: boolean; orgSlug?: string } = {},
): Promise<PersistMovementResult> {
  const r = getRepos()

  let createdProducts: CreatedProduct[] = []
  if (opts.createMissingProducts && mapped.newProducts?.length) {
    createdProducts = await createMissingProducts(orgId, mapped.newProducts, { orgSlug: opts.orgSlug })
    // Attach the resolved products to the lines that asked for them. Keyed on the name the
    // DOCUMENT used, not the product's: a reused separator twin is spelled differently by
    // definition, so keying on the product's name would leave that line without a productId —
    // and a movement line with no product is dropped, which for a receipt is silent stock drift.
    const byName = new Map(createdProducts.map(p => [p.requestedName.toLocaleLowerCase('bg'), p]))
    for (const line of mapped.lines) {
      if (line.productId) continue
      const hit = byName.get((line.sourceText || line.productName || '').toLocaleLowerCase('bg'))
      if (hit) line.productId = hit.productId
    }
  }

  // Delivered prices refresh the product master. The mapper computes them per line, but only
  // the /movement/with-update endpoint ever consumed them — through this path they were dropped,
  // so a receipt booked its quantities while the catalog kept stale costs and empty tiers.
  // Receipts only: a transfer or write-off out of the warehouse must not reprice anything.
  if (mapped.type === 'receipt') await applyDeliveredPrices(orgId, mapped.lines)

  const usable = mapped.lines.filter(l => l.productId)
  const droppedLines = mapped.lines.filter(l => !l.productId).map(l => l.productName || l.sourceText || '')
  if (!usable.length) {
    throw new Error(
      droppedLines.length
        ? `none of the ${droppedLines.length} line(s) matched a product — create them first`
        : 'the document has no lines',
    )
  }

  const movementNumber = await nextMovementNumber(orgId)
  const movement: any = await r.stockMovements.create({
    orgId,
    movementNumber,
    type: mapped.type,
    status: 'draft',
    date: mapped.date ? new Date(mapped.date) : new Date(),
    fromWarehouseId: mapped.fromWarehouseId,
    toWarehouseId: mapped.toWarehouseId,
    contactId: mapped.contactId,
    reference: mapped.reference,
    notes: mapped.notes,
    lines: usable.map(l => ({
      productId: l.productId,
      quantity: l.quantity,
      unitCost: l.unitCost,
      totalCost: +(l.quantity * l.unitCost).toFixed(2),
      // Record what the разписка delivered so reopening the movement shows
      // "With product update" with the Цена / Цена1..Цена5 it actually carried.
      ...(mapped.type === 'receipt' && l.productUpdate ? { productUpdate: l.productUpdate } : {}),
      ...(mapped.type === 'receipt' && l.priceTiers ? { priceTiers: l.priceTiers } : {}),
    })),
    totalAmount: +usable.reduce((s, l) => s + l.quantity * l.unitCost, 0).toFixed(2),
    createdBy: userId,
  } as any)

  const id = String(movement.id || movement._id)
  let status = 'draft'
  if (opts.confirm !== false) {
    // Confirming is the only step that writes stock.
    const confirmed = await confirmMovement(id)
    status = (confirmed as any)?.status || 'completed'
  }

  createAuditEntry({
    orgId, userId, action: 'create', module: 'warehouse', entityType: 'stock_movement',
    entityId: id, entityName: movementNumber,
  })

  return { id, movementNumber, status, createdProducts, droppedLines }
}

/** Movements carrying this marker already exist — the marker lives inside `notes`. */
export async function movementExists(orgId: string, marker: string): Promise<boolean> {
  const rows: any[] = await StockMovement.find(
    { orgId, notes: { $regex: marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }, status: { $ne: 'cancelled' } } as any,
    { notes: 1 },
  ).limit(20).lean()
  return rows.some(r => String(r.notes || '').includes(marker))
}
