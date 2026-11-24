import { heldQuantity, reservationRowFrom } from './figures'
import { mergeFlags, needsAttention } from './tree-rows'
import type { ReservationRow, ServerReservation, SupplyInput, TreeFlag, TreeNode } from './types'

/**
 * FR-28.45 — where a reservation sits, as a tree.
 *
 * A reservation hangs on a supply: a warehouse's line on a supplier order, or the free stock of a warehouse. This is
 * that supply with every reservation on it, in the node model and the columns of the supplier order's tree, so the
 * same component draws it. It answers "who reserved how much" on the reservation's own page (FR-22.40).
 *
 *  - on a supplier order: the order's line, each warehouse it was given, and the reservations on each warehouse;
 *  - on free stock: the warehouse, and the reservations on its stock.
 *
 * PURE and read-only: nothing here has an action. This reservation is among the rows, always: a cancelled one is no
 * longer a hold, but the page about it still shows where it was. Every other cancelled reservation is left out.
 */

const num = (v: unknown) => Number(v) || 0

export const supplyLineNodeId = (lineId: string) => `l:${lineId}`
export const supplyAllocationNodeId = (allocationId: string) => `a:${allocationId}`
export const supplyStockNodeId = (warehouseId: string) => `a:stock:${warehouseId}`
export const supplyReservationNodeId = (resId: string) => `r:${resId}`

export interface SupplyOptions {
  /** A client's name, for a reservation the server did not name. */
  contactName(id: string): string
  /** The reservation the page is about. */
  thisId: string
}

export interface SupplyTree {
  nodes: TreeNode[]
  index: Map<string, TreeNode>
  /** The node of the page's own reservation, to highlight; empty when it is not on this supply. */
  thisNodeId: string
  /** How many reservations are rows. */
  rows: number
}

interface Row {
  r: ServerReservation
  row: ReservationRow
}

export function buildSupplyTree(supply: SupplyInput, opts: SupplyOptions): SupplyTree {
  const index = new Map<string, TreeNode>()
  const register = (node: TreeNode): TreeNode => {
    index.set(node.id, node)
    return node
  }
  const thisId = String(opts.thisId)

  // Live reservations, and this one whatever its state.
  const all: Row[] = supply.reservations
    .filter((r) => r.status !== 'cancelled' || String(r._id) === thisId)
    .map((r) => ({ r, row: reservationRowFrom(r, { readonly: true }) }))

  function reservationNode(x: Row, parentId: string, depth: number): TreeNode {
    return register({
      id: supplyReservationNodeId(x.row.resId!),
      parentId,
      kind: 'reservation',
      depth,
      label: x.r.contactName || opts.contactName(x.row.contactId) || '—',
      figures: { quantity: x.row.quantity, reserved: heldQuantity(x.r), free: null, received: null, invoiced: x.row.invoiced, dispatched: x.row.dispatched },
      status: x.row.status,
      flags: [],
      rolledFlags: [],
      actions: [],
      defaultOpen: false,
      children: [],
      source: { groupIndex: 0 },
      reservation: x.row,
    })
  }

  /** What a set of reservation rows adds up to. */
  const sum = (rows: Row[]) => {
    let reserved = 0
    let invoiced = 0
    let dispatched = 0
    for (const x of rows) {
      reserved += heldQuantity(x.r)
      if (x.r.status !== 'cancelled') {
        invoiced += x.row.invoiced
        dispatched += x.row.dispatched
      }
    }
    return { reserved, invoiced, dispatched }
  }

  function placeholder(parentId: string, depth: number): TreeNode {
    return register({
      id: `ph:${parentId}:reservation`,
      parentId,
      kind: 'placeholder',
      depth,
      label: '',
      figures: { quantity: 0, reserved: 0, free: null, received: null, invoiced: 0, dispatched: 0 },
      flags: [],
      rolledFlags: [],
      actions: [],
      defaultOpen: false,
      children: [],
      placeholderOf: 'reservation',
      source: { groupIndex: 0 },
    })
  }

  let nodes: TreeNode[] = []

  if (supply.kind === 'stock' && supply.warehouse) {
    const w = supply.warehouse
    const id = supplyStockNodeId(w._id)
    const { reserved, invoiced, dispatched } = sum(all)
    const children = all.map((x) => reservationNode(x, id, 1))
    if (!children.length) children.push(placeholder(id, 1))
    nodes = [register({
      id,
      kind: 'allocation',
      depth: 0,
      label: w.name,
      // On the shelf, what these reservations hold, and what a new one could still take: the server's own figure, which
      // also counts every other hold on this stock (a supplier order's goods already received into it).
      figures: { quantity: num(w.onHand), reserved, free: Math.max(0, num(w.available)), received: null, invoiced, dispatched },
      flags: [],
      rolledFlags: [],
      actions: [],
      defaultOpen: true,
      children,
      source: { groupIndex: 0 },
    })]
  } else if (supply.kind === 'order' && supply.line) {
    const line = supply.line
    const lineId = supplyLineNodeId(line._id)
    const allocs = supply.allocations || []
    const allocated = allocs.reduce((s, a) => s + num(a.quantity), 0)

    const allocationNodes = allocs.map((a) => {
      const aid = supplyAllocationNodeId(a._id)
      const rows = all.filter((x) => x.row.allocationId === String(a._id))
      const quantity = num(a.quantity)
      const { reserved, invoiced, dispatched } = sum(rows)
      const children = rows.map((x) => reservationNode(x, aid, 2))
      if (!children.length) children.push(placeholder(aid, 2))
      return register({
        id: aid,
        parentId: lineId,
        kind: 'allocation',
        depth: 1,
        label: a.warehouseName,
        figures: { quantity, reserved, free: Math.max(0, quantity - reserved), received: num(a.receivedQuantity), invoiced, dispatched },
        flags: [],
        rolledFlags: [],
        actions: [],
        defaultOpen: rows.length > 0,
        children,
        source: { groupIndex: 0 },
      })
    })

    const quantity = num(line.quantity)
    const own: TreeFlag[] = []
    if (allocated > quantity) own.push('overAllocated')
    if (quantity > 0 && quantity - allocated > 0) own.push('unallocated')
    const rolled = mergeFlags(own, ...allocationNodes.map((c) => c.rolledFlags))
    const lineRows = allocationNodes.flatMap((a) => a.children).filter((c) => c.kind === 'reservation')
    let reserved = 0
    let invoiced = 0
    let dispatched = 0
    for (const a of allocationNodes) {
      reserved += a.figures.reserved
      invoiced += a.figures.invoiced
      dispatched += a.figures.dispatched
    }
    nodes = [register({
      id: lineId,
      kind: 'line',
      depth: 0,
      label: line.description || '',
      figures: { quantity, reserved, free: Math.max(0, quantity - allocated), received: num(line.receivedQuantity), invoiced, dispatched },
      flags: own,
      rolledFlags: rolled,
      actions: [],
      defaultOpen: lineRows.length > 0 || needsAttention(rolled),
      children: allocationNodes,
      source: { groupIndex: 0 },
    })]
  }

  const thisNode = index.get(supplyReservationNodeId(thisId))
  let rows = 0
  for (const n of index.values()) if (n.kind === 'reservation') rows++
  return { nodes, index, thisNodeId: thisNode ? thisNode.id : '', rows }
}
