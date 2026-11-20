/**
 * FR-25 R3, slice 3: the books' own cost of a goods group as of a sale (`costBasis: 'books'`, §3.5). Import-pure: the
 * caller (`group-cost.service.ts`) sums the company's 304 lines per group and business day in Mongo, and this walks
 * those sums.
 *
 * The rules:
 *   - **The state at the START of the sale's business day.** The day itself does not count: nothing records in which
 *     order a day's purchases and sales happened, and the books' own entry of the very sale this is compared with
 *     must never feed the cost it is compared by.
 *   - **An imported opening restates the year** (`books-ledger.ts`): on its day every group stands at what the opening
 *     says, and a group it does not name at nothing. It counts for that day: the opening is the state before the
 *     year's first operation.
 *   - **The average is value over quantity on hand** (Σ debit − Σ credit on 304 with the group's analytic, quantity
 *     likewise: added on the debit, taken on the credit, as `analyticTrialBalance` reads it).
 *   - **No quantity on hand keeps the last average** (§3.5); with none ever, the books' last booked unit cost of a sale
 *     of the group. A group the books never held before the day has no cost, and its document waits.
 */

/** One business day's movement of one goods group on 304, summed over every org of the company's books. */
export interface CostBucket {
  /** The group's path: what an org of a split names it by (ids differ between orgs, R7). */
  path: string
  /** `YYYY-MM-DD` */
  day: string
  /** The imported opening's lines, not a movement. */
  opening: boolean
  debit: number
  credit: number
  quantityDebit: number
  quantityCredit: number
}

interface State {
  quantity: number
  value: number
  /** The average of the last state that had goods on hand. */
  lastAverage?: number
  /** The unit cost of the last day a sale took the group off. */
  lastCreditUnit?: number
}

interface Point {
  day: string
  start: State
  end: State
}

const EPS = 1e-9
const unitOf = (s: State): number | undefined => (s.quantity > EPS && s.value >= 0 ? s.value / s.quantity : s.lastAverage ?? s.lastCreditUnit)
const withAverage = (s: State): State => (s.quantity > EPS && s.value >= 0 ? { ...s, lastAverage: s.value / s.quantity } : s)

export class GroupCostBook {
  private readonly timelines = new Map<string, Point[]>()

  /** `openingDays`: the days of the imported openings the buckets start from, whether or not they name a group. */
  constructor(buckets: readonly CostBucket[], openingDays: readonly string[] = []) {
    const byPath = new Map<string, Map<string, CostBucket[]>>()
    for (const b of buckets) {
      const days = byPath.get(b.path) ?? new Map<string, CostBucket[]>()
      days.set(b.day, [...(days.get(b.day) ?? []), b])
      byPath.set(b.path, days)
    }
    const openings = new Set(openingDays)
    for (const [path, byDay] of byPath) {
      const days = [...new Set([...byDay.keys(), ...openings])].sort()
      const points: Point[] = []
      let state: State = { quantity: 0, value: 0 }
      for (const day of days) {
        const today = byDay.get(day) ?? []
        if (openings.has(day) || today.some(b => b.opening)) {
          const o = today.filter(b => b.opening)
          state = withAverage({
            quantity: o.reduce((s, b) => s + b.quantityDebit - b.quantityCredit, 0),
            value: o.reduce((s, b) => s + b.debit - b.credit, 0),
            ...(state.lastAverage !== undefined ? { lastAverage: state.lastAverage } : {}),
            ...(state.lastCreditUnit !== undefined ? { lastCreditUnit: state.lastCreditUnit } : {}),
          })
        }
        const start = state
        const moves = today.filter(b => !b.opening)
        const sold = moves.reduce((s, b) => s + b.quantityCredit, 0)
        const soldValue = moves.reduce((s, b) => s + b.credit, 0)
        state = withAverage({
          ...state,
          quantity: state.quantity + moves.reduce((s, b) => s + b.quantityDebit - b.quantityCredit, 0),
          value: state.value + moves.reduce((s, b) => s + b.debit - b.credit, 0),
          ...(sold > EPS && soldValue >= 0 ? { lastCreditUnit: soldValue / sold } : {}),
        })
        points.push({ day, start, end: state })
      }
      this.timelines.set(path, points)
    }
  }

  /** The group's unit cost at the start of `day` (`YYYY-MM-DD`), or nothing when the books held none of it before. */
  unitCostAt(path: string, day: string): number | undefined {
    const points = this.timelines.get(path)
    if (!points) return undefined
    let lo = 0
    let hi = points.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (points[mid].day <= day) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (found < 0) return undefined
    const p = points[found]
    return unitOf(p.day === day ? p.start : p.end)
  }
}
