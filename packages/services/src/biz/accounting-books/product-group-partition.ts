import {
  evidenceOf, evidenceOfDocument, isAccountants, planProductGroups, qtyKey, tallyEvidence,
  type BooksSalesEntry, type Evidence, type EvidenceOutcome, type GroupVote, type LgrSalesDocument, type MapPlan, type MapRow, type PairedDocument,
} from './product-groups.js'

/**
 * FR-25 R3, slice 1b: a product's group from the books' quantities per group (§6.1, §9 "R3 after R7").
 *
 * The accountant books a sale's cost one operation per group, not per line, so most paired documents give slice 1's
 * rules (`product-groups.ts`) nothing. Each group's quantity is still the sum of its lines' quantities, and that is
 * enough when only one way of splitting LGR's goods lines between the groups adds up. This file finds every such
 * split, and teaches a product a group only when every split gives it that group. Import-pure.
 *
 * The rules, each one tested (`unit/product-group-partition.test.ts`):
 *   - Exact sums, in `qtyKey` units (thousandths, the sign dropped), the entry's operations of one group summed into
 *     one bin. Every goods line is placed: a line with no product too (it occupies its quantity and teaches nothing),
 *     and LGR's goods total must be the books', or the document teaches nothing. A goods line the books carry as a
 *     service is the case that must not teach, so no line is ever left out to make the sums meet.
 *   - One product, one group: a product's lines on a document are one item.
 *   - Complete or nothing: a document teaches only from a search that went to its end. A cap or the step budget
 *     stops it first, and then it teaches nothing and is counted. Its latest search decides: out of steps under
 *     today's anchors, a document keeps nothing an earlier pass taught.
 *   - Anchors: a product the run already maps is placed in its group. The accountant's rows (`source: 'accountant'`
 *     or a `reviewedAt`) are hard. `exact` and this run's `learned` rows are automatic: a document whose sums meet
 *     only when one of them is dropped contradicts it, teaches nothing, and the anchor goes to the conflict path (a
 *     learned row is taken away; an exact row stays, with the document in its `conflictCount`). A document that fits
 *     only without the accountant's rows teaches nothing, and the rows stay as they are.
 *   - A document names a group for a product only while no anchor holds the product, so a document never confirms
 *     an anchor it was given, and slice 1's two rules keep their votes as they are.
 *   - Passes: what a pass learns anchors the next, until no anchor changes. A vote found under some anchors holds
 *     under more of them, never under fewer, so the anchors may only grow between two restarts. A contradiction
 *     restarts the passes from slice 1's anchors without the contradicting documents, and so does a pass that takes
 *     an anchor away (its product's learned row anchors nothing from then on): nothing learned from a dropped anchor
 *     survives it. Each restart drops a document or a product for good, so the passes end; they are bounded all the
 *     same, and when they run out partition teaches nothing.
 *
 * ⚠ Anchors are this run's: the accountant's rows, the exact names and what this run learns. A learned row stored by
 * an earlier run is no anchor, so a run is a function of the books, the documents, the names and the accountant's
 * rows, and a second run plans nothing.
 */

// ── limits ───────────────────────────────────────────────────────────────────────────────────────

export interface PartitionLimits {
  /** Goods items of one document: a product's lines are one, a line with no product is one. */
  lines: number
  /** Goods groups of one books entry. */
  groups: number
  /** Search steps for one books entry, its searches together: each a state decided, and decided once. */
  steps: number
  /** Passes over the documents in one run, every restart's included. */
  passes: number
}

export const PARTITION_LIMITS: Readonly<PartitionLimits> = { lines: 30, groups: 12, steps: 50_000, passes: 100 }

// ── the search ───────────────────────────────────────────────────────────────────────────────────

/** An item to place, in `qtyKey` units. */
export interface SearchItem {
  size: number
  /** The bin it must take. Negative, or no such bin: there is no placement. */
  at?: number
  /** The bin of an anchor: the item must take it, except where a question sets it aside. Negative: a bin the problem does not have. */
  soft?: number
  /** With `marks: 'votes'`: asked whether it can take one bin or more. */
  votes?: boolean
}

/**
 * What a search answers. `fit`: whether a placement exists. `votes`: also the bins of each `votes` item, up to two (an
 * item that can take two is taught nothing, whatever a third would be). `all`: every item's bins, and with `relax` the
 * `relaxed` of every `soft` item.
 */
export type SearchMarks = 'fit' | 'votes' | 'all'

export interface SearchResult {
  /** The search went to its end. When it did not, nothing below is proof. */
  complete: boolean
  /** Some placement fills every bin exactly, every `at` and `soft` held. */
  fit: boolean
  /** `[item][bin]`: some such placement puts the item in the bin. Exact for what `marks` asks; else what was found. */
  feasible: boolean[][]
  /** `[item][bin]`, with `relax` and only for a `soft` item: some placement holding every anchor but this item's puts it in this other bin. */
  relaxed: boolean[][]
  steps: number
}

const OUT_OF_STEPS = new Error('out of steps')
/** A question's round ran out of its steps: it decided nothing, and is asked again with more. */
const ROUND_OVER = new Error('round over')
/** The steps of a question's first round; each next round has four times as many. */
const FIRST_ROUND = 32

/** The steps the searches of one books entry have taken, and how many they may take. */
interface Meter {
  steps: number
  budget: number
}

const gcd = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b]
  return a
}

/** The `soft` of an item that may take any bin. */
const FREE = -2

/** Per depth and bin: the room the items still to place may fill, the smallest of them, and whether one of them is anchored there. */
interface Tables {
  room: number[][]
  least: number[][]
  pinned: boolean[][]
}

/** One problem's placements, asked one question at a time. Every answer is exact; a question out of steps throws. */
interface Fits {
  /** Some placement exists, every anchor held. */
  fit(): boolean
  /** Some placement puts item `i` in bin `g`, every anchor held but item `i`'s own `soft` (never its `at`). */
  canPlace(i: number, g: number): boolean
  /** The bins item `i` can take with every anchor held, asked until there are `upTo` of them. */
  bins(i: number, upTo: number): number[]
  /** `canPlace` for some bin of `gs`. */
  placeable(i: number, gs: readonly number[]): boolean
  /** `[item][bin]`: a placement found so far, every anchor held, puts the item there. */
  seen: boolean[][]
}

/**
 * Placements of `items` that fill every bin exactly, each item in one bin. A depth-first search, largest item first,
 * each state (the items placed so far, the room left in each bin) decided once and remembered, with three cuts: a bin
 * with more room than the items that may still go there can fill is dead, so is one with less room than the smallest
 * of them, and of two bins with the same room and no anchor in either only one is tried (the placements through the
 * other are the same, the two bins swapped). Each item tries first the bin the last placement found gave it, so a
 * question near a known placement is answered near it.
 *
 * A question about one item and bin places the item before the search: the states after its depth are the problem's
 * own, the states before it are the item's whatever the bin, and both keep what they learned for the next question.
 * An item's bins are asked in rounds of growing step limits, so a bin quick to place is found before one slow to
 * refute is refuted. A round cut short decides nothing; only the meter's budget ends the search.
 */
function fitsOf(capacities: readonly number[], items: readonly SearchItem[], meter: Meter): Fits {
  const k = capacities.length
  const seen = items.map(() => new Array<boolean>(k).fill(false))
  /** `[item][bin]`: no placement with every anchor held puts the item there. */
  const never = items.map(() => new Array<boolean>(k).fill(false))
  // One unit for every size and room, their greatest common divisor, so a state's key stays short.
  const unit = [...capacities, ...items.map(it => it.size)].reduce(gcd, 0) || 1
  // The state: st[0] the depth, st[1 + g] the room left in bin g. The `at` items take their bins before anything else.
  const st = [0, ...capacities.map(c => c / unit)]
  let possible = true
  for (const it of items) {
    if (it.at === undefined) continue
    if (it.at >= 0 && it.at < k && st[1 + it.at] >= it.size / unit) st[1 + it.at] -= it.size / unit
    else possible = false
  }
  // Largest first: it has the fewest bins it fits. The sort is stable, so equal sizes keep the caller's order.
  const order = items.flatMap((it, i) => (it.at === undefined ? [i] : [])).sort((a, b) => items[b].size - items[a].size)
  const n = order.length
  const size = order.map(i => items[i].size / unit)
  const soft = order.map(i => items[i].soft ?? FREE)
  const depthOf = new Array<number>(items.length).fill(-1)
  order.forEach((i, d) => { depthOf[i] = d })
  const allowed = (d: number, g: number) => soft[d] === FREE || soft[d] === g
  /** The bin each item took in the last placement found with every anchor held, -1 before the first. */
  const hint = new Array<number>(n).fill(-1)

  /** The tables of every depth, the item at depth `skip` left out (a question places it before the search). */
  const tablesOf = (skip: number): Tables => {
    const t: Tables = { room: [new Array<number>(k).fill(0)], least: [new Array<number>(k).fill(Infinity)], pinned: [new Array<boolean>(k).fill(false)] }
    for (let d = n - 1; d >= 0; d--) {
      const [room, least, pinned] = [t.room[0], t.least[0], t.pinned[0]]
      const out = d === skip
      t.room.unshift(room.map((r, g) => r + (!out && allowed(d, g) ? size[d] : 0)))
      t.least.unshift(least.map((l, g) => (!out && allowed(d, g) ? Math.min(l, size[d]) : l)))
      t.pinned.unshift(pinned.map((p, g) => p || (!out && soft[d] === g)))
    }
    return t
  }
  const B = tablesOf(-1)
  // Per state, the bin its item took on the way to a placement, or -1: none. A question item's own for depths 0..q.
  const base = new Map<string, number>()
  const byItem = new Map<number, { tables: Tables; memo: Map<string, number> }>()
  // The question: the item at depth `q` is already in its bin. q = -1: none.
  let q = -1
  let T = B
  let memo = base

  // The round's limit on a question's steps; the meter's budget is the search's.
  let roundSteps = 0
  let roundLimit = Infinity
  const tick = () => {
    if (++meter.steps > meter.budget) throw OUT_OF_STEPS
    if (++roundSteps > roundLimit) throw ROUND_OVER
  }
  // A state as one character a number while every number fits one (the room only shrinks from here).
  const keyOf = Math.max(n, ...st) < 0xffff ? () => String.fromCharCode.apply(null, st) : () => st.join(',')

  /** The room left can still be filled by the items from `d` on. */
  const fits = (d: number) => {
    const room = T.room[d]
    const least = T.least[d]
    for (let g = 0; g < k; g++) {
      const c = st[1 + g]
      if (c > room[g] || (c > 0 && c < least[g])) return false
    }
    return true
  }
  /** A bin tried before `g` in this state that has its room and, as `g` has, no anchor. `first` is tried first. */
  const twinTried = (g: number, c: number, first: number, pinned: readonly boolean[]) => {
    if (g === first) return false
    if (first >= 0 && st[1 + first] === c && !pinned[first]) return true
    for (let h = 0; h < g; h++) if (h !== first && st[1 + h] === c && !pinned[h]) return true
    return false
  }
  /** The items from `d` on fill the room left exactly. The caller checked `fits(d)`. */
  function ok(d: number): boolean {
    if (d === q) d++
    if (d === n) return true
    const m = d <= q ? memo : base
    st[0] = d
    const key = keyOf()
    const hit = m.get(key)
    if (hit !== undefined) return hit >= 0
    tick()
    const pinned = T.pinned[d]
    const s = size[d]
    const first = hint[d]
    let took = -1
    for (let j = -1; j < k && took < 0; j++) {
      const g = j < 0 ? first : j
      if (g < 0 || (j >= 0 && g === first)) continue
      const c = st[1 + g]
      if (c < s || !allowed(d, g) || (!pinned[g] && twinTried(g, c, first, pinned))) continue
      st[1 + g] = c - s
      if (fits(d + 1) && ok(d + 1)) took = g
      st[1 + g] = c
    }
    m.set(key, took)
    return took >= 0
  }

  // Bins with the same room and no anchor before anything is placed: swapping two of them maps placements to placements.
  const rootRoom = st.slice(1)
  const twinsOf = (g: number) => (B.pinned[0][g] ? [g] : rootRoom.flatMap((c, h) => (c === rootRoom[g] && !B.pinned[0][h] ? [h] : [])))
  /** A placement under the current question (its item in bin `qb`). With `strict` (every anchor held) it is marked, with its bins' twins. */
  const attempt = (strict: boolean, qb = -1): boolean => {
    if (!possible || !fits(0) || !ok(0)) return false
    if (!strict) return true
    const took: number[] = []
    for (let d = 0; d < n; d++) {
      if (d === q) { took.push(qb); continue }
      st[0] = d
      const g = (d <= q ? memo : base).get(keyOf()) ?? -1
      // Every state on the way was decided with a bin, so this cannot be; refuse rather than mark a wrong bin.
      if (g < 0) throw new Error('product-group-partition: a placement without its bin')
      took.push(g)
      st[1 + g] -= size[d]
    }
    took.forEach((g, d) => {
      if (d !== q) st[1 + g] += size[d]
      hint[d] = g
      for (const h of twinsOf(g)) seen[order[d]][h] = true
    })
    items.forEach((it, i) => { if (it.at !== undefined) seen[i][it.at] = true })
    return true
  }

  let fitted: boolean | undefined
  const fit = () => (fitted ??= attempt(true))
  /** One question, within `limit` steps (`ROUND_OVER` past them, the state as it was). */
  const question = (i: number, g: number, limit: number): boolean => {
    const d = depthOf[i]
    if (d < 0) return items[i].at === g && fit()
    if (!(g >= 0 && g < k)) return false
    const strict = allowed(d, g)
    if (strict && (seen[i][g] || never[i][g] || !fit())) return seen[i][g]
    if (!possible || st[1 + g] < size[d]) return false
    const own = byItem.get(d) ?? { tables: tablesOf(d), memo: new Map<string, number>() }
    byItem.set(d, own)
    const saved = st.slice()
    q = d
    T = own.tables
    memo = own.memo
    st[1 + g] -= size[d]
    roundSteps = 0
    roundLimit = limit
    try {
      const yes = attempt(strict, g)
      if (!yes && strict) for (const h of twinsOf(g)) never[i][h] = true
      return yes
    } finally {
      saved.forEach((v, j) => { st[j] = v })
      q = -1
      T = B
      memo = base
      roundLimit = Infinity
    }
  }
  /** Asks bins `gs` of item `i` in rounds of growing step limits until `enough`, and returns the bins that take it. */
  const ask = (i: number, gs: readonly number[], enough: (yes: number) => boolean): number => {
    let yes = 0
    let open = [...gs]
    for (let limit = FIRST_ROUND; open.length && !enough(yes); limit *= 4) {
      const next: number[] = []
      for (const g of open) {
        if (enough(yes)) break
        try {
          if (question(i, g, limit)) yes++
        } catch (e) {
          if (e !== ROUND_OVER) throw e
          next.push(g)
        }
      }
      open = next
    }
    return yes
  }
  const canPlace = (i: number, g: number) => ask(i, [g], y => y > 0) > 0
  const bins = (i: number, upTo: number): number[] => {
    const d = depthOf[i]
    const have = () => seen[i].filter(Boolean).length
    const gs = seen[i].flatMap((y, g) => (!y && !never[i][g] && (d < 0 ? items[i].at === g : allowed(d, g)) ? [g] : []))
    if (have() < upTo) ask(i, gs, () => have() >= upTo)
    return seen[i].flatMap((y, g) => (y ? [g] : []))
  }
  const placeable = (i: number, gs: readonly number[]) => ask(i, gs, y => y > 0) > 0
  return { fit, canPlace, bins, placeable, seen }
}

/**
 * Every bin filled exactly, each item in one bin: whether such a placement exists, and which bins each item can take
 * over all of them (`fitsOf` has the method). `marks` says how much is asked (`SearchMarks`); every answer is exact.
 */
export function searchFits(
  capacities: readonly number[],
  items: readonly SearchItem[],
  budget: number,
  opts: { relax?: boolean; marks?: SearchMarks } = {},
): SearchResult {
  const marks = opts.marks ?? 'all'
  const k = capacities.length
  const meter: Meter = { steps: 0, budget }
  const none = () => items.map(() => new Array<boolean>(k).fill(false))
  const relaxed = none()
  try {
    const f = fitsOf(capacities, items, meter)
    const fit = f.fit()
    if (fit && marks !== 'fit') items.forEach((it, i) => { if (marks === 'all' || it.votes) f.bins(i, marks === 'all' ? k : 2) })
    if (opts.relax && marks === 'all') {
      items.forEach((it, i) => {
        if (it.soft === undefined || it.at !== undefined) return
        for (let g = 0; g < k; g++) if (g !== it.soft) relaxed[i][g] = f.canPlace(i, g)
      })
    }
    return { complete: true, fit, feasible: fit ? f.seen.map(r => [...r]) : none(), relaxed, steps: meter.steps }
  } catch (e) {
    if (e !== OUT_OF_STEPS) throw e
    return { complete: false, fit: false, feasible: none(), relaxed: none(), steps: meter.steps }
  }
}

// ── one books entry against its LGR document ─────────────────────────────────────────────────────

export type PartitionOutcome =
  /** A fit, and with the anchors every product on the document is in one group in every fit. */
  | 'unique'
  /** A fit; of the products no anchor holds, some are in one group in every fit and some are not. */
  | 'partial'
  /** Fits, and they agree on none of the products no anchor holds. */
  | 'ambiguous'
  /** No fit: the totals differ, or no split gives every group the books' quantity. */
  | 'none'
  /** More goods items than `PARTITION_LIMITS.lines`: not searched. */
  | 'too_many_lines'
  /** More groups than `PARTITION_LIMITS.groups`: not searched. */
  | 'too_many_groups'
  /** The search ran out of steps: nothing is proof. */
  | 'budget'
  /** Fits only when an automatic anchor (exact or learned) is dropped: the anchor is contradicted. */
  | 'anchor_contradicts'
  /** Fits only without the accountant's rows. */
  | 'accountant_contradicts'

export const PARTITION_OUTCOMES: readonly PartitionOutcome[] = [
  'unique', 'partial', 'ambiguous', 'none', 'too_many_lines', 'too_many_groups', 'budget', 'anchor_contradicts', 'accountant_contradicts',
]

/** A product's group as the search takes it. */
export interface Anchor {
  groupId: string
  /** The accountant's row: never relaxed, never blamed. */
  hard: boolean
}

export interface EntryPartition {
  outcome: PartitionOutcome
  /** The group of each product no anchor holds that every fit puts in one group. */
  votes: GroupVote[]
  /** With `anchor_contradicts`: the products whose automatic anchors the document contradicts, sorted. */
  blamed: string[]
  /** With `none`: the books' goods total is not LGR's. */
  totalsDiffer: boolean
  steps: number
}

const sum = (xs: Iterable<number>) => {
  let s = 0
  for (const x of xs) s += x
  return s
}

/**
 * What one books entry's quantities per group say about the products of its LGR document. `fixed`: products a line
 * of this entry already maps (slice 1's unique quantity), placed in that group and never voted. `anchors`: the run's
 * map, by product.
 */
export function partitionOf(
  entry: BooksSalesEntry,
  doc: LgrSalesDocument,
  opts: { fixed?: ReadonlyMap<string, string>; anchors?: ReadonlyMap<string, Anchor>; limits?: Partial<PartitionLimits> } = {},
): EntryPartition {
  const limits = { ...PARTITION_LIMITS, ...opts.limits }
  // One budget for every search of the entry.
  const meter: Meter = { steps: 0, budget: limits.steps }
  const result = (outcome: PartitionOutcome, more: Partial<EntryPartition> = {}): EntryPartition => ({ outcome, votes: [], blamed: [], totalsDiffer: false, steps: meter.steps, ...more })
  if (entry.mixed) return result('none')

  // The books: a bin per group, its operations summed.
  const perGroup = new Map<string, number>()
  for (const op of entry.goods) perGroup.set(op.groupId, (perGroup.get(op.groupId) ?? 0) + qtyKey(op.quantity))
  const groups = [...perGroup.keys()].sort()
  const capacities = groups.map(g => perGroup.get(g) ?? 0)
  const binOf = new Map(groups.map((g, i) => [g, i]))
  // LGR: a product's lines are one item, a line with no product is one of its own.
  const perProduct = new Map<string, number>()
  const typed: number[] = []
  for (const l of doc.lines) {
    if (l.service) continue
    if (l.productId) perProduct.set(l.productId, (perProduct.get(l.productId) ?? 0) + qtyKey(l.quantity))
    else typed.push(qtyKey(l.quantity))
  }
  // Strict sums: a line the books carry elsewhere (as a service) must not teach, so none is ever left out to fit.
  if (sum(capacities) !== sum(perProduct.values()) + sum(typed)) return result('none', { totalsDiffer: true })
  if (!groups.length || !(perProduct.size + typed.length)) return result('none')
  if (perProduct.size + typed.length > limits.lines) return result('too_many_lines')
  if (groups.length > limits.groups) return result('too_many_groups')

  // Items in an order of their own, so the input's order changes nothing: larger first, then by product.
  type Kind = 'fixed' | 'hard' | 'soft' | 'open'
  const items: (SearchItem & { productId?: string; kind: Kind })[] = []
  const products = [...perProduct.entries()].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
  for (const [productId, size] of products) {
    const fixed = opts.fixed?.get(productId)
    const anchor = opts.anchors?.get(productId)
    if (fixed !== undefined) items.push({ size, at: binOf.get(fixed) ?? -1, productId, kind: 'fixed' })
    else if (anchor?.hard) items.push({ size, at: binOf.get(anchor.groupId) ?? -1, productId, kind: 'hard' })
    else if (anchor) items.push({ size, soft: binOf.get(anchor.groupId) ?? -1, productId, kind: 'soft' })
    else items.push({ size, productId, kind: 'open', votes: true })
  }
  for (const size of typed.sort((a, b) => b - a)) items.push({ size, kind: 'open' })

  try {
    const strict = fitsOf(capacities, items, meter)
    if (strict.fit()) {
      const votes: GroupVote[] = []
      let open = 0
      items.forEach((it, i) => {
        if (it.kind !== 'open' || !it.productId) return
        open++
        const bins = strict.bins(i, 2)
        if (bins.length === 1) votes.push({ productId: it.productId, groupId: groups[bins[0]] })
      })
      return result(votes.length === open ? 'unique' : votes.length ? 'partial' : 'ambiguous', { votes })
    }

    // No fit with every anchor held: whose fault?
    const soft = items.flatMap((it, i) => (it.kind === 'soft' ? [i] : []))
    if (soft.length) {
      const loose = fitsOf(capacities, items.map(it => (it.kind === 'soft' ? { size: it.size } : it)), meter)
      if (loose.fit()) {
        // Its anchor alone set aside gives a fit, or no fit without the automatic anchors puts it in its group.
        const refuted = (i: number) => {
          const own = items[i].soft ?? -1
          return !(own >= 0 && loose.canPlace(i, own)) || strict.placeable(i, groups.flatMap((_, g) => (g === own ? [] : [g])))
        }
        const blamed = soft.filter(refuted)
        return result('anchor_contradicts', { blamed: (blamed.length ? blamed : soft).map(i => String(items[i].productId)).sort() })
      }
    }
    if (items.some(it => it.kind === 'hard')) {
      const bare = fitsOf(capacities, items.map(it => (it.kind === 'hard' || it.kind === 'soft' ? { size: it.size } : it)), meter)
      if (bare.fit()) return result('accountant_contradicts')
    }
    return result('none')
  } catch (e) {
    if (e !== OUT_OF_STEPS) throw e
    return result('budget')
  }
}

// ── a run ────────────────────────────────────────────────────────────────────────────────────────

export interface PartitionCounts {
  /** Paired documents slice 1 leaves a product line on, with a books entry this reads. */
  documents: number
  /**
   * One a document: `anchor_contradicts` once it contradicted an anchor; else, of its searches since the last restart,
   * the one that taught the most (`budget` when the latest ran out of steps).
   */
  outcomes: Record<PartitionOutcome, number>
  /** Of `none`: the books' goods total is not LGR's. */
  totalsDiffer: number
  /** Passes over the documents, every restart's included. */
  passes: number
  /** Restarts: a document contradicted its anchors, or a pass took away a group an earlier one had learned. */
  restarts: number
  /** The passes ran out before the anchors settled: partition taught nothing, and the plan is slice 1's alone. */
  passLimit: boolean
  /** The documents' product lines slice 1 left, and how many of them partition taught. */
  lines: { left: number; taught: number }
  products: {
    /** Named a group by partition on at least one document. */
    voted: number
    /** Learned now, and not on slice 1's evidence alone. */
    added: number
    /** Learned on slice 1's evidence alone, and not now. */
    takenAway: number
    /** Their automatic anchor is contradicted by a document. */
    contradicted: number
    /** A pass took away the group an earlier pass had learned for them: no anchor for the rest of the run. */
    distrusted: number
  }
  /** Search steps run in the whole run, and the most one document took in one pass. */
  steps: { total: number; max: number }
}

export interface PartitionLearning {
  plan: MapPlan
  /** Slice 1's votes and partition's, by product and group: what `plan` was made from. */
  evidence: Evidence
  /** Per product, the documents that contradict its automatic anchor. */
  contradicted: Map<string, number>
  counts: PartitionCounts
}

/** The slice-1 outcomes partition reads the entry of: the others teach everything, or nothing that sums can help. */
const PARTITION_FROM: ReadonlySet<EvidenceOutcome> = new Set<EvidenceOutcome>(['not_line_for_line', 'no_unique_quantity', 'line_for_line'])

interface Candidate {
  doc: LgrSalesDocument
  /** The entries partition reads, each with the products slice 1 matched on it (`null`: it put one product in two groups). */
  entries: { entry: BooksSalesEntry; fixed: Map<string, string> | null }[]
  /** The products of the product lines slice 1 left, one per line. */
  left: string[]
  /** Every product on the document, sorted: what a search's anchors are read from. */
  products: string[]
}

interface DocPartition {
  outcome: PartitionOutcome
  votes: GroupVote[]
  blamed: string[]
  totalsDiffer: boolean
}

const RANK: Record<PartitionOutcome, number> = {
  anchor_contradicts: 0, unique: 1, partial: 2, ambiguous: 3, accountant_contradicts: 4, budget: 5, too_many_lines: 6, too_many_groups: 7, none: 8,
}

function candidatesOf(paired: readonly PairedDocument[], slice1: ReadonlyMap<string, readonly GroupVote[]>): Candidate[] {
  const out: Candidate[] = []
  for (const p of [...paired].sort((a, b) => (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0))) {
    const covered = new Set((slice1.get(p.doc.id) ?? []).map(v => v.productId))
    const goods = p.doc.lines.filter(l => !l.service)
    const left = goods.flatMap(l => (l.productId && !covered.has(l.productId) ? [l.productId] : []))
    if (!left.length) continue
    const entries: Candidate['entries'] = []
    for (const entry of p.entries) {
      const ev = evidenceOf(entry, p.doc)
      if (!PARTITION_FROM.has(ev.outcome)) continue
      let fixed: Map<string, string> | null = new Map()
      for (const v of ev.outcome === 'line_for_line' ? ev.votes : []) {
        if (fixed?.has(v.productId) && fixed.get(v.productId) !== v.groupId) fixed = null
        else fixed?.set(v.productId, v.groupId)
      }
      entries.push({ entry, fixed })
    }
    if (!entries.length) continue
    out.push({ doc: p.doc, entries, left, products: [...new Set(goods.flatMap(l => (l.productId ? [l.productId] : [])))].sort() })
  }
  return out
}

/** A plan's rows as anchors: the accountant's hard, `exact` and `learned` automatic, a `distrusted` product's learned row none. */
function anchorsOf(after: ReadonlyMap<string, MapRow>, distrusted: ReadonlySet<string>): Map<string, Anchor> {
  const out = new Map<string, Anchor>()
  for (const [productId, row] of after) {
    if (isAccountants(row)) out.set(productId, { groupId: row.analyticId, hard: true })
    else if (row.source === 'exact' || (row.source === 'learned' && !distrusted.has(productId))) out.set(productId, { groupId: row.analyticId, hard: false })
  }
  return out
}

/** The products whose anchor in `a` is not the same in `b`. */
const droppedFrom = (a: ReadonlyMap<string, Anchor>, b: ReadonlyMap<string, Anchor>) =>
  [...a].flatMap(([p, x]) => {
    const y = b.get(p)
    return y && y.groupId === x.groupId && y.hard === x.hard ? [] : [p]
  })

const learnedOf = (plan: MapPlan) => new Set([...plan.after].flatMap(([p, r]) => (r.source === 'learned' && !isAccountants(r) ? [p] : [])))

/**
 * The run's plan with partition's evidence: slice 1's votes as they are, then passes of partition over the documents
 * slice 1 leaves a product line on, until the anchors settle (the file's header has the rules). Same arguments as
 * `planProductGroups`, plus the paired documents and, optionally, slice 1's votes per document (`evidenceOfDocument`'s,
 * computed when not given).
 */
export function learnWithPartition(input: {
  paired: readonly PairedDocument[]
  slice1?: readonly { doc: LgrSalesDocument; votes: readonly GroupVote[] }[]
  goodsProducts: readonly string[]
  exact: ReadonlyMap<string, string>
  exactAmbiguous: number
  activeGroups: ReadonlySet<string>
  existing: readonly MapRow[]
  limits?: Partial<PartitionLimits>
}): PartitionLearning {
  const limits = { ...PARTITION_LIMITS, ...input.limits }
  const slice1 = input.slice1 ?? input.paired.map(p => ({ doc: p.doc, votes: evidenceOfDocument(p).votes }))
  const slice1Evidence = tallyEvidence(slice1)
  const hardRows = input.existing.filter(isAccountants)
  const planOf = (evidence: Evidence, contradicted: ReadonlyMap<string, number>, existing: readonly MapRow[], goodsProducts: readonly string[]) =>
    planProductGroups({ goodsProducts, exact: input.exact, exactAmbiguous: input.exactAmbiguous, evidence, activeGroups: input.activeGroups, existing, contradicted })

  const candidates = candidatesOf(input.paired, new Map(slice1.map(t => [t.doc.id, t.votes])))
  const counts: PartitionCounts = {
    documents: candidates.length,
    outcomes: Object.fromEntries(PARTITION_OUTCOMES.map(o => [o, 0])) as Record<PartitionOutcome, number>,
    totalsDiffer: 0, passes: 0, restarts: 0, passLimit: false,
    lines: { left: sum(candidates.map(c => c.left.length)), taught: 0 },
    products: { voted: 0, added: 0, takenAway: 0, contradicted: 0, distrusted: 0 },
    steps: { total: 0, max: 0 },
  }

  // A document's search is a function of its anchors: solved once for each set it meets.
  const solved = new Map<string, DocPartition>()
  const solve = (c: Candidate, anchors: ReadonlyMap<string, Anchor>): DocPartition => {
    const key = `${c.doc.id}|${c.products.map(p => { const a = anchors.get(p); return a ? `${a.hard ? 'h' : 's'}${a.groupId}` : '' }).join(',')}`
    const hit = solved.get(key)
    if (hit) return hit
    const parts = c.entries.map(({ entry, fixed }) => (fixed ? partitionOf(entry, c.doc, { fixed, anchors, limits }) : null))
    const stepsHere = sum(parts.map(r => r?.steps ?? 0))
    counts.steps.total += stepsHere
    counts.steps.max = Math.max(counts.steps.max, stepsHere)
    const results: DocPartition[] = parts.map(r => r ?? { outcome: 'none', votes: [], blamed: [], totalsDiffer: false })
    const contradicting = results.filter(r => r.outcome === 'anchor_contradicts')
    let out: DocPartition
    if (contradicting.length) {
      out = { outcome: 'anchor_contradicts', votes: [], blamed: [...new Set(contradicting.flatMap(r => r.blamed))].sort(), totalsDiffer: false }
    } else {
      // As slice 1 reads a document of several entries: every entry's votes, the counts of the one that teaches most.
      const best = results.reduce((a, b) => (b.votes.length > a.votes.length || (b.votes.length === a.votes.length && RANK[b.outcome] < RANK[a.outcome]) ? b : a))
      const seen = new Map(results.flatMap(r => r.votes).map(v => [`${v.productId}|${v.groupId}`, v]))
      out = { ...best, votes: [...seen.values()] }
    }
    solved.set(key, out)
    return out
  }

  // Documents that contradicted an anchor, with the products they blame: they teach nothing for the rest of the run.
  const excluded = new Map<string, string[]>()
  // Products a pass took the learned group of: their learned rows anchor nothing for the rest of the run.
  const distrusted = new Set<string>()
  const contradictedNow = () => {
    const out = new Map<string, number>()
    for (const blamed of excluded.values()) for (const p of blamed) out.set(p, (out.get(p) ?? 0) + 1)
    return out
  }
  const anchorsFrom = (evidence: Evidence) => anchorsOf(planOf(evidence, contradictedNow(), hardRows, []).after, distrusted)

  let anchors = anchorsFrom(slice1Evidence)
  /** Per document, since the last restart: the votes of every pass, and the search that taught the most. */
  let taught = new Map<string, Map<string, GroupVote>>()
  let best = new Map<string, DocPartition>()
  /** Per document, its latest search whatever the restart: what the counts show when the passes run out. */
  const latest = new Map<string, DocPartition>()
  let evidence = slice1Evidence
  let settled = false
  const restart = () => {
    counts.restarts++
    anchors = anchorsFrom(slice1Evidence)
    taught = new Map()
    best = new Map()
  }
  while (counts.passes < limits.passes) {
    counts.passes++
    const contradicting: [string, string[]][] = []
    for (const c of candidates) {
      const id = c.doc.id
      if (excluded.has(id)) continue
      const r = solve(c, anchors)
      latest.set(id, r)
      if (r.outcome === 'anchor_contradicts') {
        contradicting.push([id, r.blamed])
        continue
      }
      if (r.outcome === 'budget') {
        // Out of steps: nothing it found is proof under these anchors, so it teaches nothing now.
        taught.delete(id)
        best.set(id, r)
        continue
      }
      const votes = taught.get(id) ?? new Map<string, GroupVote>()
      for (const v of r.votes) votes.set(`${v.productId}|${v.groupId}`, v)
      taught.set(id, votes)
      const prev = best.get(id)
      if (!prev || prev.outcome === 'budget' || r.votes.length > prev.votes.length || (r.votes.length === prev.votes.length && RANK[r.outcome] < RANK[prev.outcome])) best.set(id, r)
    }
    if (contradicting.length) {
      for (const [id, blamed] of contradicting) excluded.set(id, blamed)
      restart()
      continue
    }
    evidence = tallyEvidence(slice1.map(t => {
      const votes = taught.get(t.doc.id)
      return votes?.size ? { doc: t.doc, votes: [...t.votes, ...votes.values()] } : t
    }))
    const next = anchorsFrom(evidence)
    // A vote found under some anchors holds under more of them, never under fewer: a pass that takes an anchor away
    // restarts the passes, the product's learned group no anchor from then on.
    const dropped = droppedFrom(anchors, next)
    if (dropped.length) {
      for (const p of dropped) distrusted.add(p)
      restart()
      continue
    }
    if (next.size === anchors.size) {
      settled = true
      break
    }
    anchors = next
  }

  counts.passLimit = !settled
  const contradicted = settled ? contradictedNow() : new Map<string, number>()
  const plan = planOf(settled ? evidence : slice1Evidence, contradicted, input.existing, input.goodsProducts)

  for (const c of candidates) {
    const id = c.doc.id
    const r = excluded.has(id) ? undefined : (best.get(id) ?? latest.get(id))
    const outcome = excluded.has(id) ? 'anchor_contradicts' : r?.outcome
    if (outcome) counts.outcomes[outcome]++
    if (r?.totalsDiffer) counts.totalsDiffer++
    const votes = settled ? taught.get(id) : undefined
    if (votes?.size) {
      const named = new Set([...votes.values()].map(v => v.productId))
      counts.lines.taught += c.left.filter(p => named.has(p)).length
    }
  }
  const voted = new Set(settled ? [...taught.values()].flatMap(m => [...m.values()].map(v => v.productId)) : [])
  // What this run learns with partition and without it, the rows an earlier run stored aside: counts of the run's own.
  const before = learnedOf(planOf(slice1Evidence, new Map(), hardRows, input.goodsProducts))
  const after = learnedOf(planOf(settled ? evidence : slice1Evidence, contradicted, hardRows, input.goodsProducts))
  counts.products = {
    voted: voted.size,
    added: [...after].filter(p => !before.has(p)).length,
    takenAway: [...before].filter(p => !after.has(p)).length,
    contradicted: contradicted.size,
    distrusted: distrusted.size,
  }
  return { plan, evidence: settled ? evidence : slice1Evidence, contradicted, counts }
}
