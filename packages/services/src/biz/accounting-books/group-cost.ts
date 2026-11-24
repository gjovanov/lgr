/**
 * FR-25 R3, slice 3: the cost of a goods group as of a sale (`costBasis: 'books'`, §3.5): the group's moving average,
 * replayed from the books' opening and what came in on 304. Import-pure: the caller (`group-cost.service.ts`) sums the
 * company's 304 lines per group and business day in Mongo, and this walks those sums.
 *
 * The rules:
 *   - **The state at the START of the sale's business day.** The day itself does not count: nothing records in which
 *     order a day's purchases and sales happened, and the books' own entry of the very sale this is compared with
 *     must never feed the cost it is compared by.
 *   - **An imported opening restates the year** (`books-ledger.ts`): on its day every group stands at what the opening
 *     says, and a group it does not name at nothing. It counts for that day: the opening is the state before the
 *     year's first operation.
 *   - **What comes in, comes in at the books' value; what goes out, goes out at the average** (§3.5's own rule), the
 *     day's goods in before the day's goods out:
 *     - Goods in (debits with a quantity, a purchase net of what went back to the supplier that day) are averaged in
 *       with what is on hand. With nothing on hand, or less than nothing (sold before the purchase was booked), what is
 *       left after them costs what came in, as in the books' own euro average; a group still short after them keeps its
 *       last average, which measured closer to the books than the unit of a purchase covering part of a shortfall.
 *     - A day that sent more back to the supplier than it bought sends it back at the average its day starts with.
 *     - A value without goods (a debit or credit without a quantity: a discount, a cost added, a value corrected) moves
 *       the value of what is on hand, and with nothing on hand nothing.
 *     - Goods out (credits with a quantity: a sale, net of the day's returns, goods written off) leave at the average
 *       after the day's goods in, so a sale never moves the average of what is left. A group bought and sold on the
 *       same day leaves what is left at what it cost, not at the price difference between the two.
 *   - ⚠ **The books' cost of a sale never feeds the average.** Read off the books' balance (value over quantity on
 *     hand), every cost the books got wrong would stay in the value left on hand and skew every later sale of the
 *     group, for the rest of the year. The books' cost of a sale is what the dry run checks the shadow against, never
 *     what it is built from (§9, "R3, slice 3, as built").
 *   - **The replay is not the shadow's balance.** The shadow posts a day's sales at the average the day starts with
 *     (the first rule), and the replay takes them out at the average after the day's goods in: the two differ only on a
 *     day that buys and sells the same group.
 *   - **No quantity on hand keeps the last average** (§3.5); with none ever, the books' last booked unit cost of a sale
 *     of the group, and until there is one, what goes out goes out as booked. A group the books never held before the
 *     day has no cost, and its document waits.
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
  /** The part of `debit` on lines without a quantity: a discount, a cost added. Absent: none. */
  debitValueOnly?: number
  /** The part of `credit` on lines without a quantity: a value corrected. Absent: none. */
  creditValueOnly?: number
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
        const sum = (f: (b: CostBucket) => number) => moves.reduce((s, b) => s + f(b), 0)
        const debitValueOnly = sum(b => b.debitValueOnly ?? 0)
        const creditValueOnly = sum(b => b.creditValueOnly ?? 0)

        // What came in first, net of what went back to the supplier the same day.
        const cameIn = sum(b => b.quantityDebit)
        const cameInValue = sum(b => b.debit) - debitValueOnly
        const startUnit = unitOf(start)
        // Nothing on hand, or less than nothing: what is on hand after the day's goods in costs what came in.
        const restart = cameIn > EPS && !(start.quantity > EPS && start.value >= 0)
        let value = start.value + cameInValue
        if (restart) value = (start.quantity + cameIn) * (cameInValue / cameIn)
        else if (cameIn < -EPS && startUnit !== undefined) value = start.value + cameIn * startUnit
        const quantity = start.quantity + cameIn
        if (quantity > EPS) value += debitValueOnly - creditValueOnly
        const afterIn = withAverage({ ...start, quantity, value })

        // Then what went out, net of the day's returns, at the average after what came in.
        const sold = sum(b => b.quantityCredit)
        const soldAsBooked = sum(b => b.credit) - creditValueOnly
        const unit = unitOf(afterIn)
        state = withAverage({
          ...afterIn,
          quantity: afterIn.quantity - sold,
          value: afterIn.value - (unit === undefined ? soldAsBooked : sold * unit),
          ...(sold > EPS && soldAsBooked >= 0 ? { lastCreditUnit: soldAsBooked / sold } : {}),
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
