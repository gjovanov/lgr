import {
  addGroupFigures,
  countedQuantity,
  createOrderFigures,
  emptyGroupFigures,
  isBlankLine,
  type OrderFigures,
} from './figures'
import { mergeFlags, needsAttention } from './tree-rows'
import type {
  AddingRow,
  AllocationInput,
  GroupInput,
  LineInput,
  ReservationRow,
  SupplierGroupTree,
  SupplierOrderTree,
  TreeAction,
  TreeFlag,
  TreeFigures,
  TreeLabels,
  TreeNode,
} from './types'

/**
 * FR-28.37 — a supplier order's lines, warehouses and client reservations as nodes.
 *
 * line → warehouse (an allocation) → client reservation, each parent carrying what its children add up
 * to in the same columns, so closing a level loses nothing a glance needs. Built from the state of the
 * form (see `figures.ts`), and rebuilt whenever it changes: the nodes are a reading of the form, never
 * a copy of it. Edits go to the form through the `source` a node carries.
 */

// ── ids ──
// Stable while the row is the same row, so the open state and the focus follow it.
export const lineNodeId = (line: LineInput, gi: number, li: number) => `l:${line._id || line._key || `${gi}.${li}`}`
export const allocationNodeId = (a: AllocationInput, gi: number, li: number, ai: number) => `a:${a._id || a._key || `${gi}.${li}.${ai}`}`
export const reservationNodeId = (row: ReservationRow) => (row.createKey ? `r:new:${row.createKey}` : `r:${row.resId}`)
export const placeholderNodeId = (parentId: string, of: 'allocation' | 'reservation') => `ph:${parentId}:${of}`
export const editorNodeId = (parentId: string) => `ed:${parentId}`

const NO_FIGURES: TreeFigures = { quantity: 0, reserved: 0, free: null, received: null, invoiced: 0, dispatched: 0 }

export interface BuildOptions {
  figures: OrderFigures
  labels: TreeLabels
  readonly: boolean
  /** The inline row being added, if any: it is the last child of its parent and keeps the parent open. */
  adding?: AddingRow | null
}

export function buildSupplierOrderTree(groups: readonly GroupInput[], opts: BuildOptions): SupplierOrderTree {
  const { figures, labels, readonly } = opts
  const adding = opts.adding || null
  const index = new Map<string, TreeNode>()
  const totals = emptyGroupFigures()
  const out: SupplierGroupTree[] = []

  const register = (node: TreeNode): TreeNode => {
    index.set(node.id, node)
    return node
  }

  function placeholder(parentId: string, depth: number, of: 'allocation' | 'reservation', editing: boolean, action: TreeAction | null, source: TreeNode['source']): TreeNode {
    return register({
      id: editing ? editorNodeId(parentId) : placeholderNodeId(parentId, of),
      parentId,
      kind: 'placeholder',
      depth,
      label: '',
      figures: NO_FIGURES,
      flags: [],
      rolledFlags: [],
      actions: action && !editing ? [action] : [],
      defaultOpen: false,
      children: [],
      placeholderOf: of,
      editing,
      source,
    })
  }

  function reservationNode(row: ReservationRow, parentId: string, source: TreeNode['source']): TreeNode {
    const flags: TreeFlag[] = row.cancelled ? ['cancelledOnSave'] : row.createKey ? ['new'] : row.changed ? ['changed'] : []
    const actions: TreeAction[] = []
    if (row.editable && row.canChangeClient) actions.push({ type: 'changeClient' })
    if (!readonly && !row.cancelled && row.cancellable) actions.push({ type: 'cancel' })
    if (!readonly && row.cancelled) actions.push({ type: 'undo' })
    return register({
      id: reservationNodeId(row),
      parentId,
      kind: 'reservation',
      depth: 2,
      label: labels.contact(row.contactId),
      figures: { quantity: row.quantity, reserved: countedQuantity(row), free: null, received: null, invoiced: row.invoiced, dispatched: row.dispatched },
      status: row.status,
      flags,
      rolledFlags: flags,
      actions,
      defaultOpen: false,
      children: [],
      source,
      reservation: row,
    })
  }

  function allocationNode(line: LineInput, alloc: AllocationInput, rows: ReservationRow[], lineId: string, gi: number, li: number, ai: number): TreeNode {
    const id = allocationNodeId(alloc, gi, li, ai)
    const source = { groupIndex: gi, lineIndex: li, allocationIndex: ai }
    const f = figures.allocation(alloc, rows)
    const canClient = !readonly && !!line.productId && !!alloc.warehouseId
    const addClient: TreeAction | null = canClient ? { type: 'addClient', disabled: (f.free ?? 0) <= 0 } : null
    const actions: TreeAction[] = []
    if (addClient) actions.push(addClient)
    if (!readonly) actions.push({ type: 'remove' })

    const children = rows.map((r) => reservationNode(r, id, source))
    const addingHere = !!adding && adding.parentId === id && adding.kind === 'reservation'
    if (addingHere) children.push(placeholder(id, 2, 'reservation', true, null, source))
    else if (!children.length) children.push(placeholder(id, 2, 'reservation', false, addClient, source))

    const rolled = mergeFlags(...children.map((c) => c.rolledFlags))
    return register({
      id,
      parentId: lineId,
      kind: 'allocation',
      depth: 1,
      label: labels.warehouse(alloc.warehouseId),
      figures: f,
      flags: [],
      rolledFlags: rolled,
      actions,
      defaultOpen: rows.length > 0 || needsAttention(rolled) || addingHere,
      children,
      source,
    })
  }

  function lineNode(line: LineInput, gi: number, li: number): TreeNode {
    const id = lineNodeId(line, gi, li)
    const source = { groupIndex: gi, lineIndex: li }
    const rowsOf = new Map<AllocationInput, ReservationRow[]>()
    for (const a of line.allocations) rowsOf.set(a, figures.rows(a))
    const lf = figures.line(line, (a) => rowsOf.get(a) || [])

    const children = line.allocations.map((a, ai) => allocationNode(line, a, rowsOf.get(a) || [], id, gi, li, ai))
    const addingHere = !!adding && adding.parentId === id && adding.kind === 'allocation'
    const addWarehouse: TreeAction | null = readonly ? null : { type: 'addWarehouse' }
    if (addingHere) children.push(placeholder(id, 1, 'allocation', true, null, source))
    else if (!children.length) children.push(placeholder(id, 1, 'allocation', false, addWarehouse, source))

    const own: TreeFlag[] = []
    if (lf.overAllocated) own.push('overAllocated')
    if (!isBlankLine(line) && lf.figures.quantity > 0 && (lf.figures.free ?? 0) > 0) own.push('unallocated')
    const rolled = mergeFlags(own, ...children.map((c) => c.rolledFlags))
    const holdsLive = [...rowsOf.values()].some((rs) => rs.length > 0)
    const actions: TreeAction[] = []
    if (addWarehouse) actions.push(addWarehouse)
    if (!readonly) actions.push({ type: 'remove' })

    return register({
      id,
      kind: 'line',
      depth: 0,
      label: line.description || '',
      figures: lf.figures,
      flags: own,
      rolledFlags: rolled,
      actions,
      defaultOpen: holdsLive || needsAttention(rolled) || addingHere,
      children,
      source,
    })
  }

  groups.forEach((g, gi) => {
    const nodes = g.lines.map((l, li) => lineNode(l, gi, li))
    const gf = figures.group(g)
    addGroupFigures(totals, gf)
    out.push({ index: gi, id: g._id || `new${gi}`, nodes, figures: gf })
  })

  return { groups: out, totals, index }
}

export { createOrderFigures }
