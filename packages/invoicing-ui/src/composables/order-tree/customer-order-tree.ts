import { lineCoverage } from 'config/order-coverage'
import { heldQuantity, isBlankLine, reservationRowFrom } from './figures'
import { mergeFlags, needsAttention } from './tree-rows'
import type {
  CustomerLineInput,
  CustomerLineServerFigures,
  CustomerOrderTotals,
  CustomerOrderTree,
  ReservationRow,
  ServerReservation,
  TreeAction,
  TreeFigures,
  TreeFlag,
  TreeNode,
} from './types'

/**
 * FR-28.44 — a customer order's lines and their reservations as nodes: two levels, a line and then the
 * reservations that cover it, in the same node model, the same columns and the same figures as the supplier order's
 * tree (`supplier-order-tree.ts`), so the same component draws both.
 *
 * PURE. The screen hands in the lines as edited, the reservations the server returned and what the server derives
 * per saved line, and gets the nodes back; it is rebuilt on every change and never a copy of the form.
 *
 * What is different from the supplier order, and why:
 *  - Reservations here are made, changed and released AT ONCE, each with its own dialog, so nothing is staged: a
 *    row is only ever what the server has. (The supplier order stages them and saves them with the order.)
 *  - A reservation the server cancelled IS a row, as it is in the sub-row this tree replaces: it says "Cancelled",
 *    holds nothing, and offers "Reserve again". On the supplier order that action lives on the flat Reservations card.
 *  - Reserved is added up from the rows (`heldQuantity`); Invoiced and Delivered are the server's per-line figures,
 *    because an invoice can name a line without naming any of its reservations, so they cannot be added up here.
 *  - Free is what is still SHORT: needed − reserved. (On the supplier order a line's Free is ordered − allocated.)
 */

const num = (v: unknown) => Number(v) || 0
const EPS = 1e-9

export const customerLineNodeId = (line: CustomerLineInput, li: number) => `l:${line._id || `0.${li}`}`
export const customerReservationNodeId = (resId: string) => `r:${resId}`
export const customerPlaceholderNodeId = (lineId: string) => `ph:${lineId}:reservation`

const NO_SERVER: CustomerLineServerFigures = { onUnsentOrder: 0, invoiced: 0, delivered: 0 }

export interface CustomerOrderOptions {
  /** The order is closed (completed, cancelled, delivered): nothing on it can change. */
  readonly: boolean
  /** Reservations can be made: the order is confirmed (or partly delivered). */
  canReserve: boolean
  /** The day the customer asked for, `YYYY-MM-DD`: a reservation whose supplier order is expected after it is late. */
  requestedDeliveryDate?: string | Date | null
  /** What the server derives per SAVED line, by its id. */
  server: Readonly<Record<string, CustomerLineServerFigures>>
}

export function buildCustomerOrderTree(
  lines: readonly CustomerLineInput[],
  reservations: readonly ServerReservation[],
  opts: CustomerOrderOptions,
): CustomerOrderTree {
  const { readonly, canReserve } = opts
  const index = new Map<string, TreeNode>()
  const totals: CustomerOrderTotals = { lines: 0, ordered: 0, reserved: 0, short: 0, invoiced: 0, delivered: 0 }

  const register = (node: TreeNode): TreeNode => {
    index.set(node.id, node)
    return node
  }

  // The reservations by the line of the customer order they serve, in the order the server gave them.
  const byLine = new Map<string, ServerReservation[]>()
  for (const r of reservations) {
    const k = String(r.internalOrderLineId || '')
    if (!k) continue
    const list = byLine.get(k)
    if (list) list.push(r)
    else byLine.set(k, [r])
  }

  function reservationNode(row: ReservationRow, r: ServerReservation, parentId: string, li: number): TreeNode {
    const flags: TreeFlag[] = row.late ? ['late'] : []
    const actions: TreeAction[] = []
    if (row.editable) actions.push({ type: 'editQuantity' })
    if (row.editable && row.cancellable) actions.push({ type: 'release' })
    if (!readonly && canReserve && row.status === 'cancelled') actions.push({ type: 'reserveAgain' })
    return register({
      id: customerReservationNodeId(row.resId!),
      parentId,
      kind: 'reservation',
      depth: 1,
      label: row.number || '',
      figures: { quantity: row.quantity, reserved: heldQuantity(r), free: null, received: null, invoiced: row.invoiced, dispatched: row.dispatched },
      status: row.status,
      flags,
      rolledFlags: flags,
      actions,
      defaultOpen: false,
      children: [],
      source: { groupIndex: 0, lineIndex: li },
      reservation: row,
    })
  }

  function lineNode(line: CustomerLineInput, li: number): TreeNode {
    const id = customerLineNodeId(line, li)
    const source = { groupIndex: 0, lineIndex: li }
    const saved = line._id ? byLine.get(String(line._id)) || [] : []
    const rows = saved.map((r) => ({ r, row: reservationRowFrom(r, { readonly, requestedDeliveryDate: opts.requestedDeliveryDate }) }))
    const server = (line._id && opts.server[String(line._id)]) || NO_SERVER

    const quantity = num(line.quantity)
    const reserved = rows.reduce((s, x) => s + heldQuantity(x.r), 0)
    const short = Math.max(0, quantity - reserved)
    const figures: TreeFigures = { quantity, reserved, free: short, received: null, invoiced: num(server.invoiced), dispatched: num(server.delivered) }

    const children = rows.map((x) => reservationNode(x.row, x.r, id, li))
    // Reservations are made from a saved line with an article, on an order that is still being served.
    const reservable = !readonly && canReserve && !!line._id && !!line.productId
    const reserve: TreeAction | null = reservable ? { type: 'reserve', disabled: short <= EPS } : null
    if (!children.length && reserve) {
      children.push(register({
        id: customerPlaceholderNodeId(id),
        parentId: id,
        kind: 'placeholder',
        depth: 1,
        label: '',
        figures: { quantity: 0, reserved: 0, free: null, received: null, invoiced: 0, dispatched: 0 },
        flags: [],
        rolledFlags: [],
        actions: [reserve],
        defaultOpen: false,
        children: [],
        placeholderOf: 'reservation',
        source,
      }))
    }

    const own: TreeFlag[] = reserved > quantity + EPS ? ['overReserved'] : []
    const rolled = mergeFlags(own, ...children.map((c) => c.rolledFlags))
    const actions: TreeAction[] = []
    if (reserve) actions.push(reserve)
    if (!readonly) actions.push({ type: 'remove' })

    if (!isBlankLine(line)) {
      totals.lines++
      totals.short += short
    }
    totals.ordered += quantity
    totals.reserved += reserved
    totals.invoiced += figures.invoiced
    totals.delivered += figures.dispatched

    return register({
      id,
      kind: 'line',
      depth: 0,
      label: line.description || '',
      figures,
      flags: own,
      rolledFlags: rolled,
      actions,
      // A line that holds reservations shows them (as the sub-row it replaces did), and so does one with something to see.
      defaultOpen: rows.length > 0 || needsAttention(rolled),
      children,
      source,
      coverage: line._id
        ? { status: lineCoverage({ quantity, reserved, onUnsentOrder: server.onUnsentOrder }).status, onUnsentOrder: num(server.onUnsentOrder) }
        : undefined,
    })
  }

  const nodes = lines.map((l, li) => lineNode(l, li))
  return { nodes, totals, index }
}
