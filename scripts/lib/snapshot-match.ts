/**
 * Which LGR product a PlusMinus stock snapshot row belongs to.
 *
 * Both systems carry twins: two articles whose names differ only in spacing or case, each with its
 * own quantity. Folding the names and keeping one product per name added PlusMinus's rows together
 * and compared the sum with whichever twin came last. That hid the other twin: when the last one
 * was the empty one, a true-up raised it to the sum, the article's stock doubled, and every later
 * comparison still said 0 (regal-sf, 2026-10-31).
 *
 * So a name with several LGR products is matched on its exact spelling first, and every product
 * gets its own line. A name with one product still takes the sum of its spellings.
 */

/** The folded name key. Two names with this key are the same article or twins of it. */
export const collapseName = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg')

export interface SnapshotRow { name: string; qty: number }

export interface SnapshotLine<P> {
  product: P
  snapshotQty: number
  lgrQty: number
  /** snapshot − LGR: above 0, LGR is too low. */
  diff: number
}

export interface SnapshotMatch<P> {
  /** One line per LGR product under a snapshot name, with or without a difference. */
  lines: SnapshotLine<P>[]
  /** Snapshot names no LGR product carries, with their spellings summed. */
  missing: SnapshotRow[]
  /** LGR products whose name is not in the snapshot. */
  lgrOnly: P[]
  /** Every folded snapshot name. */
  names: Set<string>
  /** How many snapshot names have more than one LGR product. */
  twinNames: number
}

/** A pulled `storeAvailability_*.json` warehouse object as rows. Only `СТОКИ:` is dropped: other labels are part of the name. */
export function snapshotRows(rows: Record<string, { quantity?: string | number }>): SnapshotRow[] {
  return Object.keys(rows).map(k => ({
    name: k.replace(/^СТОКИ:/, ''),
    qty: parseFloat(String(rows[k].quantity ?? '0')) || 0,
  }))
}

const groupBy = <T>(items: T[], key: (item: T) => string) => {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}
const round = (v: number) => +v.toFixed(6) + 0 // + 0 turns a rounded -0 into 0
const total = (rows: SnapshotRow[]) => round(rows.reduce((s, r) => s + r.qty, 0))

export function matchSnapshot<P extends { name?: string }>(
  rows: SnapshotRow[],
  products: P[],
  qtyOf: (product: P) => number,
): SnapshotMatch<P> {
  const nameOf = (p: P) => String(p.name || '')
  const rowsByName = groupBy(rows, r => collapseName(r.name))
  const productsByName = groupBy(products, p => collapseName(nameOf(p)))

  const lines: SnapshotLine<P>[] = []
  const missing: SnapshotRow[] = []
  let twinNames = 0
  const addLine = (product: P, snapshotQty: number) => {
    const lgrQty = qtyOf(product)
    lines.push({ product, snapshotQty, lgrQty, diff: round(snapshotQty - lgrQty) })
  }

  for (const [key, nameRows] of rowsByName) {
    const named = productsByName.get(key)
    if (!named) { missing.push({ name: nameRows[0].name, qty: total(nameRows) }); continue }
    if (named.length === 1) { addLine(named[0], total(nameRows)); continue }

    twinNames++
    // The biggest holder goes first, so of two products spelled the same it claims the row.
    const byHolding = [...named].sort((a, b) => Math.abs(qtyOf(b)) - Math.abs(qtyOf(a)))
    const unclaimed = [...nameRows]
    const expected = new Map<P, number>()
    for (const p of byHolding) {
      const at = unclaimed.findIndex(r => r.name.trim() === nameOf(p).trim())
      expected.set(p, at >= 0 ? unclaimed.splice(at, 1)[0].qty : 0)
    }
    if (unclaimed.length) {
      // A spelling no product carries still has to land once, on a product whose own spelling is not in the snapshot.
      const spelled = new Set(nameRows.map(r => r.name.trim()))
      const target = byHolding.find(p => !spelled.has(nameOf(p).trim())) ?? byHolding[0]
      expected.set(target, round(expected.get(target)! + total(unclaimed)))
    }
    for (const p of named) addLine(p, expected.get(p)!)
  }

  return {
    lines,
    missing,
    lgrOnly: products.filter(p => !rowsByName.has(collapseName(nameOf(p)))),
    names: new Set(rowsByName.keys()),
    twinNames,
  }
}
