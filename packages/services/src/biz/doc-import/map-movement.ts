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
import { Product, StockLevel, Warehouse } from 'db/models'
import { normalizeUomBg } from '../uom.utils.js'
import { clean, num } from './detect.js'
import { matchContact, matchProductsExact } from './matching.js'
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
  /** Source file name, so the movement can carry the document it came from. */
  filename?: string
}

/**
 * File-name family per document kind. This is NOT the marker prefix: a 2000 КОРЕКЦИЯ marks itself
 * `corr:` for idempotency but arrives in a `stokrazp_*.pdf`, and the reference names the FILE.
 */
const FILE_PREFIX: Partial<Record<DocKind, string>> = {
  goods_receipt: 'stokrazp',
  correction: 'stokrazp',
  transfer_note: 'sklrazp',
  issue_note: 'sklisk',
  store_operations: 'storeOperations',
  invoice: 'invoicem',
  cash_register: 'salesAnalysis',
}

/** The document a movement was booked from, as its file stem: `sklrazp_0000012698`. */
export function documentReference(kind: DocKind, docNumber: string, filename?: string): string | undefined {
  const stem = String(filename || '').replace(/.[A-Za-z0-9]+$/, '').trim()
  if (stem) return stem
  const prefix = FILE_PREFIX[kind]
  return prefix && docNumber ? `${prefix}_${docNumber}` : undefined
}

export interface MapMovementResult {
  /** Read fine, but the document delivers nothing (price-only разписка). */
  nothingToMove?: boolean
  /**
   * The zero-quantity lines of a price-only разписка, carrying the sale prices and tiers it
   * restates. Set only when `nothingToMove` and only for receipt-side families — a transfer or
   * write-off must not reprice. Without this the lines died here: they cannot enter a movement,
   * so the whole document committed as a no-op and its prices were lost.
   */
  priceOnly?: MappedMovementLine[]
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

/**
 * Each matched product's CURRENT tiers and buying price. The staged overlay has to start from what
 * the product already has: `line.priceTiers` REPLACES the product's array on commit, so building
 * it from a blank slate silently wiped every slot the разписка didn't carry.
 */
async function productPriceMap(orgId: string, productIds: string[]): Promise<Map<string, { tiers: any[]; purchasePrice: number }>> {
  const out = new Map<string, { tiers: any[]; purchasePrice: number }>()
  if (!productIds.length) return out
  const rows: any[] = await Product.find(
    { orgId, _id: { $in: productIds } } as any,
    { priceTiers: 1, purchasePrice: 1 },
  ).lean()
  for (const r of rows) out.set(String(r._id), { tiers: r.priceTiers || [], purchasePrice: Number(r.purchasePrice) || 0 })
  return out
}

/** Price-tier slots for a NEW product: cost in Доставна цена, sale tiers tagged by name. */
export function buildTiers(cost: number, tiers: Record<string, number> | undefined) {
  const delivered = canonicalTiers(tiers)
  return TIER_NAMES.map((name) => {
    const price = name === 'Доставна цена' ? cost : (delivered[name] ?? 0)
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
 * Overlay an EXISTING product's tiers with the sale prices a разписка delivered.
 *
 * A разписка carries Цена and Цена 1..N. Цена is the base SELLING price — it is not the cost,
 * and writing it into Доставна цена / purchasePrice (as this used to) overwrote the buying price
 * with a sale price on every receipt. So the cost slots — Доставна цена, Цена на едро, Цена 0 —
 * are never touched here, and neither is any Цена N the document does not carry: a receipt must
 * not wipe prices a snapshot seed set.
 *
 * `costBasis` is only used to express each tier as a margin percentage; it is never written.
 */
export function repriceTiers(existing: any[] | undefined, tiers: Record<string, number> | undefined, costBasis = 0) {
  const slots = (existing && existing.length ? existing.map((t: any) => ({ ...t })) : buildTiers(0, {}))
  for (const [name, raw] of Object.entries(canonicalTiers(tiers))) {
    if (PROTECTED_TIERS.has(name)) continue
    const price = Number(raw) || 0
    const t = slots.find((x: any) => x.name === name)
    if (!t || !(price > 0)) continue
    t.finalPrice = price
    t.percent = costBasis > 0 ? +(((price - costBasis) / costBasis) * 100).toFixed(1) : 0
    t.manualOverride = true
    t.tags = t.tags?.length ? t.tags : [name]
    t.contactIds = t.contactIds || []
  }
  return slots
}

/** Cost-side slots a разписка must leave alone — they mirror the buying price, not a sale tier. */
export const PROTECTED_TIERS = new Set(['Доставна цена', 'Цена на едро', 'Цена 0', 'Прод. цена'])

/** The sale-tier subset of a line's price columns (everything except the cost column). */
/**
 * OCR reads the tier columns off the разписка header unspaced ("Цена1"), while the catalog's
 * slots are canonical ("Цена 1"). buildTiers looks each slot up BY NAME, so without this every
 * sale tier silently resolved to 0 — the product got its cost and nothing else.
 */
/**
 * Canonical slot names keyed by their whitespace-stripped form. A wrapped header folds its
 * fragments back together without separators — „Цена на едро" arrives as „Ценанаедро" and
 * „Прод. цена" as „Прод.цена" — and an unrecognised name silently skips its slot.
 */
const CANON_BY_SQUASH = new Map<string, string>(
  [...TIER_NAMES, 'Прод. цена'].map((n) => [n.replace(/\s+/g, '').toLocaleLowerCase('bg'), n]),
)

function canonicalTierName(k: string): string {
  const m = k.match(/^\s*Цена\s*(\d+)\s*$/)
  if (m) return 'Цена ' + m[1]
  return CANON_BY_SQUASH.get(k.replace(/\s+/g, '').toLocaleLowerCase('bg')) ?? k.trim()
}

/** One price column by its canonical name, whatever spacing the wrapped heading folded it into. */
function priceColumn(prices: Record<string, number> | null | undefined, name: string): number {
  const v = Number(canonicalTiers(prices)[name])
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** A price-column record keyed by canonical slot names — slot lookup is by exact name. */
function canonicalTiers(tiers: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(tiers || {})) out[canonicalTierName(k)] = Number(v)
  return out
}

function saleTiers(prices: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(prices || {})) {
    if (k === 'Цена' || PROTECTED_TIERS.has(canonicalTierName(k))) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) out[canonicalTierName(k)] = n
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

  const matchedIds = matches.filter(Boolean).map(m => m!.productId)
  const [costs, current] = await Promise.all([
    avgCostMap(orgId, matchedIds, warehouseId),
    productPriceMap(orgId, matchedIds),
  ])

  const positive: MappedMovementLine[] = []
  /** Lines the document prices but does not deliver — see the classification below. */
  const zeroQty: MappedMovementLine[] = []
  const negative: MappedMovementLine[] = []
  const perLine: LineDiagnostic[] = []
  const newProducts: NewProductDraft[] = []

  const qtyWarnings: string[] = []

  items.forEach(({ li, desc }, i) => {
    const m = matches[i]
    let qty = num(li.quantity)
    // A quantity that wraps across physical lines in the PDF ("-79" / "43." / "000") can come
    // back TRUNCATED to its first fragment (-79 instead of -7943) — silent, and it books a
    // fraction of the real movement. The printed Стойност is the cross-check: qty × Цена must
    // reproduce it. Auto-repair ONLY the truncation signature (the extracted value is a
    // leading fragment of the recovered one); anything else is surfaced for a human.
    const printedTotal = num(li.total)
    // Prefer the EXACT unit price over the Цена column: an invoice or складова разписка prints
    // Цена rounded to 2 dp, so 600 x 0.06 "should" be 36.00 while the document says 36.42 — the
    // real price is 0.0607. Checking against the printed value flags rounding as corruption.
    const priceForCheck = num(li.unit_price ?? li.prices?.['Цена'])
    if (qty && priceForCheck > 0 && printedTotal) {
      const expected = Math.abs(qty * priceForCheck)
      if (Math.abs(expected - Math.abs(printedTotal)) > 0.02 + Math.abs(printedTotal) * 0.001) {
        const recovered = Math.abs(printedTotal) / priceForCheck
        const rounded = Math.round(recovered)
        const isTruncation = Math.abs(recovered - rounded) < 0.02
          && rounded > Math.abs(qty)
          && String(rounded).startsWith(String(Math.abs(qty)))
        if (isTruncation) {
          qtyWarnings.push(`"${desc}": quantity ${qty} did not reconcile with the printed value ${printedTotal} — read as ${qty < 0 ? -rounded : rounded} (wrapped-number truncation)`)
          qty = qty < 0 ? -rounded : rounded
        } else {
          qtyWarnings.push(`"${desc}": quantity ${qty} × price ${priceForCheck} = ${expected.toFixed(2)} but the document prints ${printedTotal} — VERIFY before committing`)
        }
      }
    }
    // „Цена" is the DELIVERY price — the Excel's „Дост. цена". Checked against the live catalog on
    // 2026-08-31: it equals the product's purchasePrice, its avgCost AND its „Доставна цена" slot on
    // every product sampled. What we SELL for is „Прод. цена", a separate column the wide layout
    // added. An older разписка carries no selling price at all, and then sellingPrice must be left
    // alone — filling it from „Цена" set every received product's price to what we paid for it.
    const deliveryPrice = num(li.prices?.['Цена'] ?? li.unit_price)
    const sellingPrice = priceColumn(li.prices, 'Прод. цена')
    const tiers = saleTiers(li.prices)

    // Existing product: keep avgCost untouched. New product: the разписка's delivery price opens it.
    const unitCost = m ? (costs.get(m.productId) ?? 0) : deliveryPrice

    const line: MappedMovementLine = {
      productId: m?.productId,
      productName: m?.name || desc,
      quantity: Math.abs(qty),
      unitCost,
      sourceText: desc,
    }
    // Delivered SALE prices update the product master through the goods-receipt-with-update path.
    // The buying price is deliberately not among them: a разписка prices what we sell it for.
    if (m && (sellingPrice > 0 || Object.keys(tiers).length)) {
      const now = current.get(m.productId)
      line.productUpdate = sellingPrice > 0 ? { sellingPrice } : {}
      line.priceTiers = repriceTiers(now?.tiers, tiers, now?.purchasePrice ?? 0) as any
    }

    // A line that delivers nothing does not belong in a stock movement. PlusMinus issues
    // PRICE-ONLY разписки — an empty Кол column throughout and a zero footer — purely to restate
    // prices; booking them as a receipt of 0 would put an empty movement in the ledger, and a
    // document made entirely of such lines must produce no movement at all.
    if (qty === 0) zeroQty.push(line)
    else if (qty < 0) negative.push(line)
    else positive.push(line)

    const candidateNew: NewProductDraft | undefined = m
      ? undefined
      : { name: desc, unit: normalizeUomBg(li.unit), cost: deliveryPrice, ...(sellingPrice > 0 ? { selling: sellingPrice } : {}), tiers }
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
  const reference = documentReference(kind, docNumber, opts.filename)
  const baseNotes = `${labelFor(kind)} — ${date || ''} (${marker})`.replace(/\s+—\s+\(/, ' (')

  // The note's „Партньор" column, when it carries one. A store-to-store transfer leaves it blank;
  // a разписка handed to a customer names them, and that is what later identifies the invoice it
  // was converted into (`findStockNoteConversion`). Never CREATED here — a разписка naming an
  // unknown party is a document to look at, not a reason to add a counterparty.
  const partySide = rule.side === 'to' ? 'supplier' : 'customer'
  const party = partySide === 'supplier' ? ext.supplier : ext.customer
  const partner = clean(party?.name) ? await matchContact(orgId, party!, partySide, { create: false }) : null
  if (clean(party?.name) && !partner) {
    warnings.push(`the document names „${clean(party?.name)}" as partner and no contact matches — booked without one. That is expected when the partner is another of the org's OWN stores rather than a counterparty (regal hands goods to „МАГАЗИН- РЕГАЛ - СОФИЯ", a second warehouse LGR does not track yet); only add a contact if it really is one.`)
  }

  const movements: MappedMovement[] = []
  const build = (type: MovementType, side: 'to' | 'from', lines: MappedMovementLine[], suffix = ''): MappedMovement => ({
    type,
    date,
    ...(side === 'to' ? { toWarehouseId: warehouseId } : { fromWarehouseId: warehouseId }),
    ...(partner ? { contactId: partner.contactId } : {}),
    notes: suffix ? `${baseNotes} ${suffix}` : baseNotes,
    marker,
    ...(reference ? { reference } : {}),
    lines,
    totalAmount: round2(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0)),
    newProducts: [],
  })

  if (kind === 'correction') {
    // A КОРЕКЦИЯ mixes increases and decreases; each half books its own movement so the
    // sign is carried by the movement type rather than by a negative quantity.
    if (positive.length) movements.push(build('receipt', 'to', positive, '(+)'))
    if (negative.length) movements.push(build('adjustment', 'from', negative, '(−)'))
  } else {
    // A negative quantity means the goods moved the OTHER way, on every kind of note — not only
    // on a КОРЕКЦИЯ. Стокова разписка 3000016326 hands 40 БОЛТ М20Х100 back and takes 40 М20Х95
    // in, and prints a negative total (−12.86 €) to say so. Folding that line into the receipt as
    // |−40| ADDED what had just left the warehouse: the error is twice the line. So the sign rides
    // on the movement TYPE here too, and the two halves book separately.
    const baseType = (opts.movementType as MovementType) || rule.type
    const baseSide = opts.movementType ? (opts.movementType === 'receipt' ? 'to' : 'from') : rule.side
    const oppSide: 'to' | 'from' = baseSide === 'to' ? 'from' : 'to'
    const oppType: MovementType = oppSide === 'to' ? 'receipt' : 'adjustment'
    const split = positive.length > 0 && negative.length > 0
    if (positive.length) movements.push(build(baseType, baseSide, positive, split ? '(+)' : undefined))
    if (negative.length) {
      movements.push(build(oppType, oppSide, negative, '(−)'))
      warnings.push(`${negative.length} line(s) had a negative quantity — booked as a separate ${oppType} ${oppSide === 'from' ? 'out of' : 'into'} the warehouse`)
    }
  }

  // Say so rather than returning an empty result silently: a price-only разписка is a real
  // document that was read correctly and deliberately moves nothing.
  // Receipt-side only: `MOVEMENT_RULES[kind].type` is 'receipt' for a разписка, a КОРЕКЦИЯ and a
  // storeOperations delivery, and a transfer or write-off out of the warehouse never reprices.
  const repricing = MOVEMENT_RULES[kind]?.type === 'receipt'
  const priceOnly = zeroQty.filter(l => l.productId && (l.productUpdate || l.priceTiers?.length))
  if (zeroQty.length && !movements.length) {
    warnings.push(
      `this document delivers nothing — ${zeroQty.length} line(s) carry prices with no quantity, so no stock movement is booked`
      + (repricing && priceOnly.length
        ? `; its prices are applied to ${priceOnly.length} product(s)`
        : ' and it restates no price we can apply'),
    )
  } else if (zeroQty.length) {
    warnings.push(`${zeroQty.length} line(s) carry no quantity and were left out of the movement`)
  }

  if (movements.length) movements[0].newProducts = newProducts
  if (newProducts.length) {
    warnings.push(`${newProducts.length} item(s) are not in the catalog — create them, or those quantities are lost`)
  }
  if (qtyWarnings.length) {
    // Quantity/value reconciliation failures are the loudest thing this mapper can say: they
    // mean the extracted number disagrees with the document's own arithmetic.
    warnings.push(...qtyWarnings)
  }
  if (!clean(ext.document_number)) {
    warnings.push('no document number — the idempotency marker falls back to the date, so a re-import may double-book')
  }

  const nothingToMove = !movements.length && zeroQty.length > 0
  return {
    movements, perLine, warnings, nothingToMove,
    ...(nothingToMove && repricing && priceOnly.length ? { priceOnly } : {}),
  }
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
  const reference = documentReference('store_operations', opts.date, opts.filename)
  const movement: MappedMovement = {
    type: 'receipt',
    date: opts.date,
    toWarehouseId: warehouseId,
    notes: `Доставки — ${opts.date} (${marker})`,
    marker,
    ...(reference ? { reference } : {}),
    lines,
    totalAmount: round2(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0)),
    newProducts,
  }

  return { movements: [movement], perLine, warnings }
}
