/**
 * Legacy stock documents → a form-shaped StockMovement mapping. **Nothing is persisted.**
 *
 * Four PDF kinds and one spreadsheet, each with a different sign and a different warehouse
 * side:
 *
 *   стокова разписка (stokrazp)      receipt     → toWarehouseId          +
 *   2000 КОРЕКЦИЯ                    split       → both                   ±  (signed lines)
 *   складова разписка (sklrazp)      transfer    → fromWarehouseId only   −  (destination untracked)
 *   искане (sklisk)                  adjustment  → fromWarehouseId only   −  (written off)
 *   storeOperations XLSX             receipt     → toWarehouseId          +
 *
 * Two rules carried over verbatim from the CLI skills, both of which are easy to get wrong
 * and expensive to discover later:
 *
 *  1. **Costing.** For a product that already exists, `unitCost` must be its CURRENT
 *     avgCost, which makes the confirm-time weighted-average recompute a no-op. Passing 0
 *     (or the разписка price) would silently drag avgCost toward that number on every
 *     receipt. For a brand-new product there is no avgCost to protect, so the разписка's
 *     `Цена` is used and becomes the opening cost.
 *  2. **Idempotency.** StockMovement has no `reference` field, so the marker lives in
 *     `notes` (`stokrazp:<n>`, `corr:<n>`, `sklrazp:<n>`, `sklisk:<n>`,
 *     `storeOperations:<date>`) — the same markers `check-doc-sequences` looks for.
 */
import { StockLevel, Warehouse } from 'db/models'
import { normalizeUomBg } from '../uom.utils.js'
import { clean, num } from './detect.js'
import { matchProductsExact } from './matching.js'
import { bgDateToIso, storeLeaf } from './parse-text.js'
import { round2, type StoreOperationsResult } from './xlsx.js'
import type {
  DocKind,
  DocumentExtraction,
  LineDiagnostic,
  MappedMovement,
  MappedMovementLine,
  NewProductDraft,
} from './types.js'

/** Canonical price-tier slots, in order. Mirrors `seed-products` / `receive-new-products`. */
export const TIER_NAMES = [
  'Доставна цена', 'Цена на едро',
  'Цена 0', 'Цена 1', 'Цена 2', 'Цена 3', 'Цена 4', 'Цена 5',
  'Цена 6', 'Цена 7', 'Цена 8', 'Цена 9', 'Цена 10',
]

export type MovementType = 'receipt' | 'dispatch' | 'transfer' | 'adjustment' | 'return'

/** How each document kind books: movement type and which warehouse side it touches. */
export const MOVEMENT_RULES: Record<string, { type: MovementType; side: 'to' | 'from' }> = {
  goods_receipt: { type: 'receipt', side: 'to' },
  correction: { type: 'receipt', side: 'to' }, // negative lines split out as an adjustment
  transfer_note: { type: 'transfer', side: 'from' },
  issue_note: { type: 'adjustment', side: 'from' },
  store_operations: { type: 'receipt', side: 'to' },
}

/** Marker prefix per kind — what makes a re-import a no-op. */
const MARKER_PREFIX: Record<string, string> = {
  goods_receipt: 'stokrazp',
  correction: 'corr',
  transfer_note: 'sklrazp',
  issue_note: 'sklisk',
  store_operations: 'storeOperations',
}

export function movementMarker(kind: DocKind, key: string): string {
  return `${MARKER_PREFIX[kind] || 'doc'}:${key}`
}

export interface MapMovementOptions {
  /** Warehouse to use when the document's own `Склад` doesn't resolve. */
  warehouseId?: string
  /** Override the derived movement type (the user can force one in the dialog). */
  movementType?: MovementType
  /** Fallback date when the document carries none. */
  date?: string
}

export interface MapMovementResult {
  /** One entry per booked movement — a correction yields two (the + and the − halves). */
  movements: MappedMovement[]
  perLine: LineDiagnostic[]
  warnings: string[]
}

/**
 * Resolve the store printed on a note to one of our warehouses. Matched on the full value
 * and on the leaf after a colon, because the exports print `ОБЕКТИ:СКЛАД - 1`.
 */
export async function resolveWarehouse(orgId: string, printed?: string | null): Promise<string | null> {
  const raw = clean(printed)
  if (!raw || /всички\s+складове/i.test(raw)) return null
  const candidates = [raw, storeLeaf(raw)].map(s => s.toLocaleLowerCase('bg'))
  const all: any[] = await Warehouse.find({ orgId, isActive: { $ne: false } } as any, { name: 1, code: 1 }).lean()
  const hit = all.find(w =>
    candidates.includes(String(w.name || '').toLocaleLowerCase('bg'))
    || candidates.includes(String(w.code || '').toLocaleLowerCase('bg')),
  )
  return hit ? String(hit._id) : null
}

/** Current average cost per product at a warehouse — the avgCost-invariant unit cost. */
async function avgCostMap(orgId: string, productIds: string[], warehouseId?: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!productIds.length) return out
  const rows: any[] = await StockLevel.find(
    { orgId, productId: { $in: productIds }, ...(warehouseId ? { warehouseId } : {}) } as any,
    { productId: 1, avgCost: 1 },
  ).lean()
  for (const r of rows) {
    const id = String(r.productId)
    if (!out.has(id)) out.set(id, Number(r.avgCost) || 0)
  }
  return out
}

/** Price-tier slots for a NEW product: cost in Доставна цена, sale tiers tagged by name. */
export function buildTiers(cost: number, tiers: Record<string, number> | undefined) {
  return TIER_NAMES.map((name) => {
    const price = name === 'Доставна цена' ? cost : (tiers?.[name] ?? 0)
    return {
      name,
      percent: cost > 0 && price > 0 ? +(((price - cost) / cost) * 100).toFixed(1) : 0,
      finalPrice: price,
      manualOverride: price > 0,
      contactIds: [] as string[],
      // The tier-name tag is what makes tag-based price resolution pick this slot.
      tags: price > 0 && name !== 'Доставна цена' ? [name] : ([] as string[]),
    }
  })
}

/**
 * Reprice an EXISTING product's tiers from a разписка: set Доставна цена = cost and overlay
 * the delivered sale tiers, but PRESERVE slots the разписка doesn't carry (Цена на едро,
 * Цена 0/6/7 …) so a receipt never wipes prices a snapshot seed set.
 */
export function repriceTiers(existing: any[] | undefined, cost: number, tiers: Record<string, number> | undefined) {
  const slots = (existing && existing.length ? existing.map((t: any) => ({ ...t })) : buildTiers(0, {}))
  const setSlot = (name: string, price: number) => {
    const t = slots.find((x: any) => x.name === name)
    if (!t) return
    t.finalPrice = price
    t.percent = cost > 0 && price > 0 ? +(((price - cost) / cost) * 100).toFixed(1) : 0
    t.manualOverride = price > 0
    t.tags = price > 0 && name !== 'Доставна цена' ? [name] : (t.tags || [])
    t.contactIds = t.contactIds || []
  }
  setSlot('Доставна цена', cost)
  for (const [name, price] of Object.entries(tiers || {})) setSlot(name, Number(price) || 0)
  return slots
}

/** The sale-tier subset of a line's price columns (everything except the cost column). */
function saleTiers(prices: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(prices || {})) {
    if (k === 'Цена' || k === 'Доставна цена') continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) out[k] = n
  }
  return out
}

// ── PDF stock documents ──────────────────────────────────────────────────────

export async function mapMovementExtraction(
  orgId: string,
  ext: DocumentExtraction,
  kind: DocKind,
  opts: MapMovementOptions = {},
): Promise<MapMovementResult> {
  const warnings: string[] = []
  const rule = MOVEMENT_RULES[kind]
  if (!rule) return { movements: [], perLine: [], warnings: [`unsupported document kind: ${kind}`] }

  const items = (ext.line_items || [])
    .map(li => ({ li, desc: clean(li.description) }))
    .filter(e => !!e.desc)

  const matches = await matchProductsExact(orgId, items.map(e => e.desc))

  const printedWarehouse = rule.side === 'to' ? ext.warehouse_to : ext.warehouse_from
  const resolved = await resolveWarehouse(orgId, printedWarehouse)
  if (printedWarehouse && !resolved) {
    warnings.push(`warehouse "${clean(printedWarehouse)}" did not match any of yours — using the selected one`)
  }
  const warehouseId = resolved || opts.warehouseId
  if (!warehouseId) warnings.push('no warehouse resolved — pick one before importing')

  const costs = await avgCostMap(orgId, matches.filter(Boolean).map(m => m!.productId), warehouseId)

  const positive: MappedMovementLine[] = []
  const negative: MappedMovementLine[] = []
  const perLine: LineDiagnostic[] = []
  const newProducts: NewProductDraft[] = []

  items.forEach(({ li, desc }, i) => {
    const m = matches[i]
    const qty = num(li.quantity)
    const cost = num(li.prices?.['Цена'] ?? li.unit_price)
    const tiers = saleTiers(li.prices)

    // Existing product: keep avgCost untouched. New product: the разписка cost opens it.
    const unitCost = m ? (costs.get(m.productId) ?? 0) : cost

    const line: MappedMovementLine = {
      productId: m?.productId,
      productName: m?.name || desc,
      quantity: Math.abs(qty),
      unitCost,
      sourceText: desc,
    }
    // Delivered prices update the product master through the goods-receipt-with-update path.
    if (m && (cost > 0 || Object.keys(tiers).length)) {
      line.productUpdate = cost > 0 ? { purchasePrice: cost } : {}
      line.priceTiers = repriceTiers(undefined, cost, tiers) as any
    }

    if (qty < 0) negative.push(line)
    else positive.push(line)

    const candidateNew: NewProductDraft | undefined = m
      ? undefined
      : { name: desc, unit: normalizeUomBg(li.unit), cost, tiers }
    if (candidateNew) newProducts.push(candidateNew)

    perLine.push({
      sourceText: desc,
      matched: !!m,
      productId: m?.productId,
      matchedBy: m?.matchedBy ?? null,
      candidateNew,
    })
  })

  const docNumber = clean(ext.document_number) || opts.date || 'unknown'
  const date = ext.issue_date || bgDateToIso(ext.issue_date) || opts.date
  const marker = movementMarker(kind, docNumber)
  const baseNotes = `${labelFor(kind)} — ${date || ''} (${marker})`.replace(/\s+—\s+\(/, ' (')

  const movements: MappedMovement[] = []
  const build = (type: MovementType, side: 'to' | 'from', lines: MappedMovementLine[], suffix = ''): MappedMovement => ({
    type,
    date,
    ...(side === 'to' ? { toWarehouseId: warehouseId } : { fromWarehouseId: warehouseId }),
    notes: suffix ? `${baseNotes} ${suffix}` : baseNotes,
    marker,
    lines,
    totalAmount: round2(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0)),
    newProducts: [],
  })

  if (opts.movementType) {
    // A forced type overrides the derived one; sign handling still follows the document.
    const side = opts.movementType === 'receipt' ? 'to' : 'from'
    if (positive.length) movements.push(build(opts.movementType, side, positive))
    if (negative.length) movements.push(build(opts.movementType, side, negative, '(−)'))
  } else if (kind === 'correction') {
    // A КОРЕКЦИЯ mixes increases and decreases; each half books its own movement so the
    // sign is carried by the movement type rather than by a negative quantity.
    if (positive.length) movements.push(build('receipt', 'to', positive, '(+)'))
    if (negative.length) movements.push(build('adjustment', 'from', negative, '(−)'))
  } else {
    const lines = [...positive, ...negative]
    if (lines.length) movements.push(build(rule.type, rule.side, lines))
    if (negative.length) {
      warnings.push(`${negative.length} line(s) had a negative quantity — booked as positive on a ${rule.type}`)
    }
  }

  if (movements.length) movements[0].newProducts = newProducts
  if (newProducts.length) {
    warnings.push(`${newProducts.length} item(s) are not in the catalog — create them, or those quantities are lost`)
  }
  if (!clean(ext.document_number)) {
    warnings.push('no document number — the idempotency marker falls back to the date, so a re-import may double-book')
  }

  return { movements, perLine, warnings }
}

function labelFor(kind: DocKind): string {
  if (kind === 'transfer_note') return 'Прехвърляне'
  if (kind === 'issue_note') return 'Отписване'
  if (kind === 'correction') return 'Корекция'
  return 'Доставки'
}

// ── storeOperations spreadsheet ──────────────────────────────────────────────

export async function mapStoreOperations(
  orgId: string,
  parsed: StoreOperationsResult,
  opts: MapMovementOptions & { date: string },
): Promise<MapMovementResult> {
  const warnings: string[] = []

  // A file whose period doesn't match the day being imported is a stale export in the
  // wrong folder — the single most common way to book a day twice.
  if (parsed.periodStart && parsed.periodStart !== opts.date) {
    warnings.push(`the export covers ${parsed.periodStart} but you are importing ${opts.date}`)
  }

  const resolved = await resolveWarehouse(orgId, parsed.warehouse)
  if (parsed.warehouse && !resolved && !/всички\s+складове/i.test(parsed.warehouse)) {
    warnings.push(`warehouse "${parsed.warehouse}" did not match any of yours — using the selected one`)
  }
  const warehouseId = resolved || opts.warehouseId
  if (!warehouseId) warnings.push('no warehouse resolved — pick one before importing')

  const matches = await matchProductsExact(orgId, parsed.rows.map(r => r.name))
  const costs = await avgCostMap(orgId, matches.filter(Boolean).map(m => m!.productId), warehouseId)

  const lines: MappedMovementLine[] = []
  const perLine: LineDiagnostic[] = []
  const newProducts: NewProductDraft[] = []

  parsed.rows.forEach((r, i) => {
    const m = matches[i]
    // Quantities only: this export's `Цена` is not authoritative, and the receive-stock
    // skill deliberately never writes prices from it.
    const unitCost = m ? (costs.get(m.productId) ?? 0) : num(r.price)
    lines.push({
      productId: m?.productId,
      productName: m?.name || r.name,
      quantity: r.qty,
      unitCost,
      sourceText: r.name,
    })
    const candidateNew: NewProductDraft | undefined = m
      ? undefined
      : { name: r.name, unit: normalizeUomBg(r.unit), cost: num(r.price), tiers: {} }
    if (candidateNew) newProducts.push(candidateNew)
    perLine.push({
      sourceText: r.name,
      matched: !!m,
      productId: m?.productId,
      matchedBy: m?.matchedBy ?? null,
      candidateNew,
    })
  })

  if (newProducts.length) {
    warnings.push(`${newProducts.length} item(s) are not in the catalog — create them, or those quantities are lost`)
  }

  const marker = movementMarker('store_operations', opts.date)
  const movement: MappedMovement = {
    type: 'receipt',
    date: opts.date,
    toWarehouseId: warehouseId,
    notes: `Доставки — ${opts.date} (${marker})`,
    marker,
    lines,
    totalAmount: round2(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0)),
    newProducts,
  }

  return { movements: [movement], perLine, warnings }
}
