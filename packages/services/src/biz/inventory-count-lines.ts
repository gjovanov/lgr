import { Product } from 'db/models'

/**
 * FR-33.13 and FR-33.14 (#933): what a stock count must hold, refused by its routes (`POST`, `PUT` and
 * `/complete` of `warehouse/inventory-count`). The form is the only writer of those routes, and it holds the same
 * rules; these are what an old tab, an API client or a script meets.
 *
 * The count an adjustment makes for itself (FR-04, `movement.controller` `/:id/confirm`) records a movement already
 * booked: it is created completed, through the repository, and never edited or completed through these routes, so
 * neither rule reaches it.
 */

export interface CountRefusal {
  code: 'count_article_repeated' | 'count_warehouse_locked'
  message: string
  [key: string]: unknown
}

const idOf = (v: unknown): string => {
  if (v && typeof v === 'object' && '_id' in v) return String((v as { _id: unknown })._id)
  return String(v ?? '')
}

/** The articles named on more than one line, each with its line numbers (1-based, in the count's order). */
export function repeatedArticles(lines: ReadonlyArray<{ productId?: unknown }> | null | undefined): Array<{ productId: string; lines: number[] }> {
  const at = new Map<string, number[]>()
  ;(Array.isArray(lines) ? lines : []).forEach((l, i) => {
    const id = idOf(l?.productId)
    if (!id) return
    at.set(id, [...(at.get(id) ?? []), i + 1])
  })
  return [...at].filter(([, n]) => n.length > 1).map(([productId, n]) => ({ productId, lines: n }))
}

/**
 * FR-33.13 — one line per article. A count whose lines name an article twice booked that article's difference
 * twice at completion (each line is measured against its own System figure): two lines of System 10, Counted 8 took
 * the stock to 6 while the shelf held 8. 422 `count_article_repeated`, naming the articles and their lines.
 */
export async function articleRepeatedRefusal(orgId: unknown, lines: ReadonlyArray<{ productId?: unknown }> | null | undefined): Promise<CountRefusal | null> {
  const repeated = repeatedArticles(lines)
  if (!repeated.length) return null
  const ids = repeated.map(r => r.productId).filter(id => /^[0-9a-f]{24}$/i.test(id))
  const products = ids.length
    ? await Product.find({ orgId: String(orgId), _id: { $in: ids } }, { name: 1, sku: 1 }).lean().exec()
    : []
  const byId = new Map((products as Array<{ _id: unknown; name?: string; sku?: string }>).map(p => [String(p._id), p]))
  const named = repeated.map(r => {
    const p = byId.get(r.productId)
    return { productId: r.productId, name: p?.name ?? '', sku: p?.sku ?? '', lines: r.lines }
  })
  const articles = named.map(a => `${a.name || a.productId}${a.sku ? ` (${a.sku})` : ''}`).join(', ')
  return {
    code: 'count_article_repeated',
    message: `A count holds each article on one line. On more than one line: ${named.map(a => `${a.name || a.productId}${a.sku ? ` (${a.sku})` : ''}, lines ${a.lines.join(', ')}`).join('; ')}.`,
    articles,
    productIds: named.map(a => a.productId),
    repeated: named,
  }
}

/**
 * FR-33.14 — the warehouse of a count with lines. Each line's System figure was read in the count's warehouse; a
 * PUT that moved the count to another warehouse kept those figures, and the completion booked them against the
 * second one. 422 `count_warehouse_locked` when the body changes `warehouseId` on a stored count that has lines and
 * the count as it would be saved still has some. A count with no lines changes its warehouse, and so does a PUT that
 * removes every line with the change ("Removing every line unlocks it", §2.4).
 */
export function warehouseLockedRefusal(
  stored: { warehouseId?: unknown; lines?: readonly unknown[] | null },
  update: { warehouseId?: unknown; lines?: readonly unknown[] | null },
): CountRefusal | null {
  if (update.warehouseId === undefined || idOf(update.warehouseId) === idOf(stored.warehouseId)) return null
  const storedLines = Array.isArray(stored.lines) ? stored.lines.length : 0
  const savedLines = Array.isArray(update.lines) ? update.lines.length : storedLines
  if (!storedLines || !savedLines) return null
  return {
    code: 'count_warehouse_locked',
    message: `This count has ${storedLines} line(s), counted against its warehouse: its warehouse cannot change while it has lines. Remove the lines first.`,
    lines: storedLines,
  }
}
