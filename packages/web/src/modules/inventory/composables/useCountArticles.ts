import { ref } from 'vue'
import { reportError } from 'ui-shared/composables/report-error'
import { listProducts } from '../api/products'
import { listStockLevels, stockByProducts, type StockByProductRow } from '../api/stock-levels'
import { STOCK_IDS_PER_REQUEST, chunks, linesFromStock, planAdditions, type CountLine, type PickedArticle } from './count-lines'

/**
 * FR-33.5 to .7 (#933): what a pick does on a stock count, from the entry line's search or from Details.
 *
 * - An article new to the count becomes a line: System is read for every picked article from ONE stock answer for the
 *   count's warehouse (`stock-level/by-products`), never one request per article; Counted starts at System (D-5).
 * - An article already on the count never makes a second line: its line is shown and highlighted, the cursor goes to
 *   its Counted, and the entry line says which line it is (D-2).
 * - Several from Details: each new one in the order ticked, and the entry line says how many were already there.
 */
export interface CountArticlesOptions {
  lines: () => readonly CountLine[]
  warehouseId: () => string
  /** Put the new lines on the count, with what was read for them: which have a level, and their units. */
  append: (lines: CountLine[], stocked: Set<string>, units: Map<string, string>) => void
  /** Bring a line into view and put the cursor in its Counted. */
  reveal: (productId: string) => Promise<void> | void
  /** A line's place in the count. */
  lineNo: (productId: string) => number
  /** The screen's `t`. */
  t: (key: string, values: Record<string, unknown>) => string
  /** The stock request; `GET /warehouse/stock-level/by-products` unless a test hands its own. */
  stockOf?: typeof stockByProducts
}

const HIGHLIGHT_MS = 2500

export function useCountArticles(opts: CountArticlesOptions) {
  const t = opts.t
  /** What the last pick did, said beside the entry line. */
  const entryNote = ref('')
  /** The line just shown because its article was picked again. */
  const highlighted = ref('')
  let highlightTimer: ReturnType<typeof setTimeout> | undefined

  function highlight(productId: string) {
    highlighted.value = productId
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => { highlighted.value = '' }, HIGHLIGHT_MS)
  }

  async function readStock(ids: string[], warehouseId: string): Promise<Record<string, StockByProductRow[]>> {
    const stock: Record<string, StockByProductRow[]> = {}
    // An id travels in the query string: past a couple of hundred articles (Details at "All") the ids go in turns.
    const stockOf = opts.stockOf ?? stockByProducts
    for (const part of chunks(ids, STOCK_IDS_PER_REQUEST)) Object.assign(stock, (await stockOf(part, warehouseId)).stock)
    return stock
  }

  async function addArticles(picked: PickedArticle[]) {
    const warehouseId = opts.warehouseId()
    if (!warehouseId || !picked.length) return
    entryNote.value = ''
    const { fresh, already } = planAdditions(opts.lines(), picked)
    let added: CountLine[] = []
    if (fresh.length) {
      let stock: Record<string, StockByProductRow[]>
      try {
        stock = await readStock(fresh.map((p) => String(p._id)), warehouseId)
      } catch (e) {
        // No System, no line: a line with a made-up System would book a difference that is not there.
        reportError(e)
        return
      }
      // The warehouse was changed while the stock was read: the figures are another warehouse's.
      if (opts.warehouseId() !== warehouseId) return
      // A pick made meanwhile may have put some of them on the count already.
      const again = planAdditions(opts.lines(), fresh)
      already.push(...again.already.filter((id) => !already.includes(id)))
      const made = linesFromStock(again.fresh, stock)
      added = made.lines
      const units = new Map(again.fresh.map((p) => [String(p._id), p.unit || ''] as [string, string]))
      opts.append(made.lines, made.stocked, units)
    }

    if (added.length && already.length) entryNote.value = t('warehouse.countLine.addedSomeThere', { n: added.length, m: already.length })
    else if (added.length > 1) entryNote.value = t('warehouse.countLine.added', { n: added.length })
    else if (!added.length && already.length === 1) entryNote.value = t('warehouse.countLine.already', { n: opts.lineNo(already[0]) })
    else if (!added.length && already.length > 1) entryNote.value = t('warehouse.countLine.allThere', { m: already.length })

    const first = added[0]?.productId ?? already[0]
    if (!first) return
    if (!added.length) highlight(first)
    await opts.reveal(first)
  }

  return { entryNote, highlighted, addArticles }
}

/**
 * A saved count's lines carry no unit, and say nothing of a level the warehouse lacks. Both are read once: the
 * warehouse's lean levels (the read "Load products" makes) give the units and the articles it keeps, and the
 * catalogue the units of the others. Context only: a refusal leaves them blank.
 */
export async function describeCountLines(warehouseId: string, productIds: readonly string[]): Promise<{ units: Map<string, string>; notStocked: string[] }> {
  const units = new Map<string, string>()
  const notStocked: string[] = []
  try {
    const { stockLevels } = await listStockLevels({ warehouseId, size: 0, fields: 'count' })
    const kept = new Set<string>()
    for (const s of stockLevels) {
      kept.add(String(s.productId))
      units.set(String(s.productId), s.productUnit || '')
    }
    for (const id of productIds) if (!kept.has(id)) notStocked.push(id)
    for (const part of chunks(notStocked, 100)) {
      const { products } = await listProducts({ ids: part.join(','), size: part.length })
      for (const p of products) units.set(String(p._id), p.unit || '')
    }
  } catch (e) {
    // The unit and the hint are context: the lines are counted without them.
    console.warn('count lines: units not read', e)
  }
  return { units, notStocked }
}
