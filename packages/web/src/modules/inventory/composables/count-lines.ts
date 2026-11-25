import type { InventoryCountBody } from '../api/inventory-counts'
import type { StockByProductRow, StockLevel } from '../api/stock-levels'

/**
 * FR-33 (#933): the rules of a stock count's lines, kept out of the form so they are tested on their own.
 *
 * - One article, one line (FR-33.7): an article already on the count never makes a second line.
 * - System is the warehouse's on-hand quantity when the line is added, 0 when the warehouse keeps no level of it
 *   (FR-33.6). Counted starts at System (D-5), so a line left untouched books nothing.
 * - "Load products" on a count that has lines adds only the levels not on it, and the lines there keep what was typed
 *   (D-1).
 * - The entry line is not a line: it is never in `lines`, so never in the payload.
 */

export interface CountLine {
  productId: string
  productName: string
  productSku?: string
  productBarcode?: string
  systemQuantity: number
  countedQuantity: number
  avgCost: number
}

/** An article as a pick hands it over: the search's hit or a row of the Details dialog. */
export interface PickedArticle {
  _id: string
  name?: string
  sku?: string
  barcode?: string
  unit?: string
}

/** How many articles one stock request names: an id is 24 characters, and the ids travel in the query string. */
export const STOCK_IDS_PER_REQUEST = 200

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Which of the picked articles are new to the count, in the order picked, and which were on it already (an article
 * picked twice in one go counts once).
 */
export function planAdditions<P extends { _id: string }>(lines: readonly CountLine[], picked: readonly P[]): { fresh: P[]; already: string[] } {
  const on = new Set(lines.map((l) => String(l.productId)))
  const taken = new Set<string>()
  const fresh: P[] = []
  const already: string[] = []
  for (const p of picked) {
    const id = String(p._id)
    if (taken.has(id)) continue
    taken.add(id)
    if (on.has(id)) already.push(id)
    else fresh.push(p)
  }
  return { fresh, already }
}

/**
 * The new lines for these articles, System read from ONE stock answer for the count's warehouse. `stocked` says
 * which of them the warehouse keeps a level of: the others show System 0 with "not stocked here".
 */
export function linesFromStock(picked: readonly PickedArticle[], stock: Record<string, StockByProductRow[] | undefined>): { lines: CountLine[]; stocked: Set<string> } {
  const stocked = new Set<string>()
  const lines = picked.map((p) => {
    const id = String(p._id)
    const rows = stock[id] || []
    if (rows.length) stocked.add(id)
    const system = rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
    return {
      productId: id,
      productName: p.name || p.sku || '',
      productSku: p.sku || '',
      productBarcode: p.barcode || '',
      systemQuantity: system,
      countedQuantity: system,
      avgCost: 0,
    }
  })
  return { lines, stocked }
}

/** A stock level of the lean read (`fields=count`) as a count line: Counted starts at System. */
export function lineFromLevel(s: StockLevel): CountLine {
  return {
    productId: s.productId,
    productName: s.productName || s.productSku,
    productSku: s.productSku || '',
    productBarcode: s.productBarcode || '',
    systemQuantity: s.quantity || 0,
    countedQuantity: s.quantity || 0,
    avgCost: s.avgCost || 0,
  }
}

/** D-1: the warehouse's levels not on the count yet, as new lines. The lines already there are not touched. */
export function missingLevels(lines: readonly CountLine[], levels: readonly StockLevel[]): CountLine[] {
  const on = new Set(lines.map((l) => String(l.productId)))
  const out: CountLine[] = []
  for (const s of levels) {
    const id = String(s.productId)
    if (on.has(id)) continue
    on.add(id)
    out.push(lineFromLevel(s))
  }
  return out
}

/** Each line's place in the count (1-based), by article. It does not change when the lines are filtered. */
export function lineNumbers(lines: readonly CountLine[]): Map<string, number> {
  const out = new Map<string, number>()
  lines.forEach((l, i) => out.set(String(l.productId), i + 1))
  return out
}

/**
 * What Save sends: the count's own fields and, per line, the article and the three figures. No cost (FR-27.11.C.4:
 * the server prices a count) and nothing of the entry line, which is not a line.
 */
export function countPayload(form: { warehouseId: string; date: string; type: string; notes: string; lines: readonly CountLine[] }): InventoryCountBody {
  return {
    warehouseId: form.warehouseId,
    date: form.date,
    type: form.type,
    notes: form.notes,
    itemCount: form.lines.length,
    varianceCount: form.lines.filter((l) => l.countedQuantity !== l.systemQuantity).length,
    lines: form.lines.map((l) => ({
      productId: l.productId,
      systemQuantity: l.systemQuantity,
      countedQuantity: l.countedQuantity,
      variance: l.countedQuantity - l.systemQuantity,
    })),
  }
}
