/**
 * How far a client order (ORDI) is covered, line by line and as a whole (FR-22.44). Import-pure:
 * the client-order list and form on the server and in the browser read it from here, so the
 * header chip, the line chips and the list column never disagree.
 *
 * A line's `reserved` is every live reservation on it (`reservedQuantity`). Part of that may sit
 * on a supplier order that was never sent — a draft that orders nothing yet. Such a line is not
 * „Резервирана": it reads „Поръчана" (`ordered`) until that order goes out.
 *
 *   none     nothing reserved
 *   partial  something reserved, not all of it
 *   ordered  all of it reserved, but some only on an unsent supplier order
 *   full     all of it reserved on stock or on supplier orders that are out
 *
 * A line ordering nothing (the blank line a form keeps for the next article) is no demand and
 * counts for nothing.
 */
export type CoverageStatus = 'none' | 'partial' | 'ordered' | 'full'

export interface LineCoverageInput {
  quantity?: number
  /** Every live reservation on the line. */
  reserved?: number
  /** Of `reserved`, what is on unsent (draft) supplier orders. */
  onUnsentOrder?: number
}

export interface LineCoverage {
  status: CoverageStatus
  reserved: number
  /** Reserved on stock or on supplier orders that went out. */
  held: number
  onUnsentOrder: number
  short: number
}

const n = (v: unknown) => Math.max(0, Number(v) || 0)
const EPS = 1e-9

export function lineCoverage(line: LineCoverageInput): LineCoverage {
  const quantity = n(line.quantity)
  const reserved = n(line.reserved)
  const onUnsentOrder = Math.min(n(line.onUnsentOrder), reserved)
  const held = reserved - onUnsentOrder
  const status: CoverageStatus = reserved <= EPS
    ? 'none'
    : held + EPS >= quantity
      ? 'full'
      : reserved + EPS >= quantity
        ? 'ordered'
        : 'partial'
  return { status, reserved, held, onUnsentOrder, short: Math.max(0, quantity - reserved) }
}

export function orderCoverage(lines: LineCoverageInput[]): { status: CoverageStatus; shortQuantity: number } {
  const demand = (lines || []).filter((l) => n(l.quantity) > EPS).map(lineCoverage)
  const shortQuantity = demand.reduce((s, l) => s + l.short, 0)
  if (!demand.length || demand.every((l) => l.status === 'none')) return { status: 'none', shortQuantity }
  if (demand.every((l) => l.status === 'full')) return { status: 'full', shortQuantity }
  if (demand.every((l) => l.status === 'full' || l.status === 'ordered')) return { status: 'ordered', shortQuantity }
  return { status: 'partial', shortQuantity }
}
