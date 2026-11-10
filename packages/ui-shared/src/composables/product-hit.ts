import { httpClient } from './useHttpClient'
import { formatUnitPrice } from './product-price-columns'

/**
 * FR-28.24 — ONE result row for the two inline product searches (`ProductSearch`, the movement and price-list
 * field; `ProductLineDescription`, a document line's description). They stay two FIELDS, because they do two
 * jobs (a movement line must name an article; a document line is a description that may stay free text, with a
 * chip once an article is picked), but they stop being two SEARCHES: the same request, the same ten hits, the
 * same row — the name, then `SKU · unit · stock · price`.
 *
 * The formatting is pure (no Vue): `unit/product-hit.test.ts` holds it.
 */

/** Two characters, a 300 ms pause and ten hits, as both widgets have always searched. */
export const SEARCH_MIN_CHARS = 2
export const SEARCH_DEBOUNCE_MS = 300
export const SEARCH_HITS = 10

/** What the screen's warehouse holds of one article, as the hit says it. */
export interface HitStock {
  /** On hand. With a warehouse named, that warehouse's; otherwise the sum over them. */
  quantity: number
  /** Held for clients (`reservedQuantity`), shown in brackets when there is any. */
  reserved: number
  /** The warehouse the figure is of, when one was asked for and has a row. */
  warehouseName?: string
}

export interface HitTextContext {
  fmtQty: (n: number) => string
  /** "2 reserved" */
  reservedLabel: (n: number) => string
  /** Name the warehouse ("Main: 4"): when the screen works in one. Without it the figure is the sum. */
  named: boolean
}

/**
 * The stock part of a hit: on hand, with what is reserved in brackets when there is any (D-11). `undefined`
 * stock is "not known": nothing is said rather than a zero that would read as "none here".
 */
export function hitStockText(stock: HitStock | undefined, ctx: HitTextContext): string {
  if (!stock) return ''
  const quantity = ctx.fmtQty(stock.quantity)
  const base = ctx.named && stock.warehouseName ? `${stock.warehouseName}: ${quantity}` : quantity
  return stock.reserved > 0 ? `${base} (${ctx.reservedLabel(stock.reserved)})` : base
}

/**
 * The price a hit shows: the one the line will start with (the selling price on a sales document, the purchase
 * price on a bill, a receipt or a supplier order). A price that is not in the answer — a role may not see it, FR-27
 * — is not in the hit either.
 */
export function hitPriceText(
  product: Record<string, any>,
  priceField: 'sellingPrice' | 'purchasePrice' | null | undefined,
  currency: string,
  locale: string,
): string {
  if (!priceField) return ''
  const value = product[priceField]
  if (value === undefined || value === null || value === '') return ''
  return formatUnitPrice(Number(value) || 0, product.currency || currency, locale)
}

/** `SKU · unit · stock · price`, with whatever is not known left out. */
export function hitSubtitle(parts: { sku?: string; unit?: string; stock?: string; price?: string }): string {
  return [parts.sku, parts.unit, parts.stock, parts.price].map((p) => String(p ?? '').trim()).filter(Boolean).join(' · ')
}

/** The article's name, as the row's first line. */
export function hitTitle(product: Record<string, any>): string {
  return String(product.name || product.displayName || '').trim()
}

// ── the requests ──

export interface HitSearchResult {
  products: any[]
  /** How many articles match in all: more than the ten shown means "Show all N results". */
  total: number
}

/**
 * The ten best ACTIVE articles for what was typed. Both widgets search through here. "Active" is one rule across the
 * product search now: the Products list, the product dialog and the till all show active articles unless asked
 * otherwise, and the inline search used to be the one that listed deactivated ones too — so "Show all 13 results"
 * could open a dialog of 12. A deactivated article is one Status change away in Details.
 */
export async function searchProductHits(orgUrl: string, text: string): Promise<HitSearchResult> {
  const { data } = await httpClient.get(`${orgUrl}/warehouse/product`, { params: { search: text, size: SEARCH_HITS, isActive: "true" } })
  const products: any[] = data.products || []
  return { products, total: Number(data.total) || products.length }
}

/**
 * What the screen's warehouse holds of each of the hits (the one bulk call the Products list also makes), or the
 * sum over the warehouses when the screen names none. A failure — a role with no stock to read — says nothing:
 * the hits then carry no stock part, which is better than a wrong one.
 */
export async function loadHitStock(orgUrl: string, ids: string[], warehouseId?: string | null): Promise<Record<string, HitStock>> {
  if (!ids.length) return {}
  try {
    const params: Record<string, string> = { productIds: ids.join(',') }
    if (warehouseId) params.warehouseId = warehouseId
    const { data } = await httpClient.get(`${orgUrl}/warehouse/stock-level/by-products`, { params })
    const out: Record<string, HitStock> = {}
    for (const id of ids) {
      const rows: Array<{ warehouseName?: string; quantity?: number }> = (data.stock || {})[id] || []
      out[id] = {
        quantity: rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0),
        reserved: Number((data.supply || {})[id]?.reserved) || 0,
        warehouseName: warehouseId && rows.length === 1 ? rows[0].warehouseName : undefined,
      }
    }
    return out
  } catch {
    return {}
  }
}
