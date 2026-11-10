import { describe, it, expect } from 'bun:test'
// PURE modules: no Vue, no store. `invoicing-ui` is not a workspace package, so they are reached by path.
import { buildSupplierOrderTree, createOrderFigures, lineNodeId, allocationNodeId } from '../../../invoicing-ui/src/composables/order-tree/supplier-order-tree'
import { countedQuantity } from '../../../invoicing-ui/src/composables/order-tree/figures'
import {
  ancestorIds,
  collapseAll,
  expandAll,
  isNodeOpen,
  mergeFlags,
  needsAttention,
  parentIds,
  revealed,
  toggled,
  visibleRows,
} from '../../../invoicing-ui/src/composables/order-tree/tree-rows'
import type {
  AddingRow,
  GroupInput,
  LineInput,
  ServerReservation,
  StagedChanges,
  TreeNode,
} from '../../../invoicing-ui/src/composables/order-tree/types'

/**
 * FR-28.37 — the node model and its one set of figures.
 *
 * The cases the requirement names — nothing allocated, over-allocated, a new allocation with a
 * staged reservation, a cancelled-on-save row, an allocation with received quantity, a line with no
 * product — and the rules of FR-28.42 that decide what is open.
 */

const NO_STAGED: StagedChanges = { creates: [], updates: {}, cancels: [] }
const labels = {
  warehouse: (id: string) => ({ main: 'Main', second: 'Second', third: 'Third' } as Record<string, string>)[id] || '—',
  contact: (id: string) => ({ c1: 'Client A', c2: 'Client B', c3: 'Client C' } as Record<string, string>)[id] || '—',
}

function res(over: Partial<ServerReservation> & { _id: string }): ServerReservation {
  return { reservationNumber: `RES-${over._id}`, status: 'active', contactId: 'c1', quantity: 10, invoicedQuantity: 0, dispatchedQuantity: 0, ...over }
}

function build(
  groups: GroupInput[],
  opts: { reservations?: ServerReservation[]; staged?: Partial<StagedChanges>; readonly?: boolean; adding?: AddingRow | null } = {},
) {
  const readonly = opts.readonly ?? false
  const figures = createOrderFigures({
    reservations: opts.reservations || [],
    staged: { ...NO_STAGED, ...(opts.staged || {}) },
    readonly,
  })
  return buildSupplierOrderTree(groups, { figures, labels, readonly, adding: opts.adding })
}

/** One supplier, one line of 100 for an article, with the allocations given. */
const orderOf = (line: Partial<LineInput> = {}): GroupInput[] => [{
  _id: 'g1',
  lines: [{ _id: 'L1', productId: 'p1', description: 'Hex bolt', quantity: 100, allocations: [], ...line }],
}]

const lineNode = (t: ReturnType<typeof build>): TreeNode => t.groups[0].nodes[0]
const actionTypes = (n: TreeNode) => n.actions.map((a) => a.type)

describe('a line with nothing allocated', () => {
  const t = build(orderOf())
  const line = lineNode(t)

  it('has its figures and the flag that says so, and a placeholder where the warehouses go', () => {
    expect(line.kind).toBe('line')
    expect(line.figures).toEqual({ quantity: 100, reserved: 0, free: 100, received: 0, invoiced: 0, dispatched: 0 })
    expect(line.flags).toEqual(['unallocated'])
    expect(line.children).toHaveLength(1)
    expect(line.children[0].kind).toBe('placeholder')
    expect(line.children[0].placeholderOf).toBe('allocation')
    expect(actionTypes(line.children[0])).toEqual(['addWarehouse'])
    expect(actionTypes(line)).toEqual(['addWarehouse', 'remove'])
  })

  it('is closed: unallocated informs, it does not open', () => {
    expect(line.defaultOpen).toBe(false)
  })

  it('adds up to its supplier and to the order', () => {
    expect(t.groups[0].figures).toEqual({ lines: 1, ordered: 100, allocated: 0, reserved: 0, received: 0, invoiced: 0, dispatched: 0 })
    expect(t.totals).toEqual(t.groups[0].figures)
  })
})

describe('a line nobody has filled in', () => {
  it('is not flagged, and is not counted as a line of the order', () => {
    const t = build([{ lines: [{ description: '', quantity: 0, allocations: [], _key: 'k1' }, { _id: 'L2', productId: 'p1', description: 'Washer', quantity: 5, allocations: [] }] }])
    expect(t.groups[0].nodes[0].flags).toEqual([])
    expect(t.groups[0].figures.lines).toBe(1)
    expect(t.groups[0].nodes[0].id).toBe('l:k1')
  })
})

describe('an over-allocated line', () => {
  const t = build(orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }, { _id: 'A2', warehouseId: 'second', quantity: 40 }] }))
  const line = lineNode(t)

  it('is flagged, has nothing left to place, and opens by itself', () => {
    expect(line.flags).toContain('overAllocated')
    expect(line.flags).not.toContain('unallocated')
    expect(line.figures.free).toBe(0)
    expect(line.defaultOpen).toBe(true)
    expect(needsAttention(line.flags)).toBe(true)
  })

  it('counts every warehouse in the supplier\'s total of what is allocated', () => {
    expect(t.groups[0].figures.allocated).toBe(110)
  })
})

describe('a line with live reservations', () => {
  const reservations = [
    res({ _id: 'r1', quantity: 25, invoicedQuantity: 10, allocationId: 'A1', internalOrderId: 'i1' }),
    res({ _id: 'r2', quantity: 15, contactId: 'c2', allocationId: 'A1' }),
    res({ _id: 'r3', quantity: 20, contactId: 'c3', allocationId: 'A2' }),
  ]
  const t = build(
    orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70, receivedQuantity: 0 }, { _id: 'A2', warehouseId: 'second', quantity: 30 }] }),
    { reservations },
  )
  const line = lineNode(t)
  const [main, second] = line.children

  it('adds the warehouses and the clients up, in the same columns, at every level', () => {
    expect(line.figures).toMatchObject({ quantity: 100, reserved: 60, free: 0, invoiced: 10 })
    expect(main.figures).toMatchObject({ quantity: 70, reserved: 40, free: 30, invoiced: 10 })
    expect(second.figures).toMatchObject({ quantity: 30, reserved: 20, free: 10, invoiced: 0 })
    expect(main.children.map((c) => c.figures.quantity)).toEqual([25, 15])
    expect(main.children.map((c) => c.label)).toEqual(['Client A', 'Client B'])
    expect(main.label).toBe('Main')
  })

  it('opens the line and the warehouses that hold them', () => {
    expect(line.defaultOpen).toBe(true)
    expect(main.defaultOpen).toBe(true)
    expect(second.defaultOpen).toBe(true)
  })

  it('gives each reservation its own status, number and what can be done to it', () => {
    const r1 = main.children[0]
    expect(r1.id).toBe('r:r1')
    expect(r1.status).toBe('active')
    expect(r1.reservation?.number).toBe('RES-r1')
    // Part of it is invoiced and it serves a client order: the client cannot be changed, it can be cancelled.
    expect(actionTypes(r1)).toEqual(['cancel'])
    expect(actionTypes(main.children[1])).toEqual(['changeClient', 'cancel'])
  })

  it('offers + Client on a warehouse with something free, and only disables it when nothing is', () => {
    expect(main.actions.find((a) => a.type === 'addClient')?.disabled).toBe(false)
    const full = build(
      orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 10 }] }),
      { reservations: [res({ _id: 'r9', quantity: 10, allocationId: 'A1' })] },
    )
    expect(lineNode(full).children[0].actions.find((a) => a.type === 'addClient')?.disabled).toBe(true)
  })

  it('does not count what the server has cancelled, and does not show it', () => {
    const t2 = build(
      orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }] }),
      { reservations: [res({ _id: 'rc', quantity: 50, allocationId: 'A1', status: 'cancelled' })] },
    )
    const alloc = lineNode(t2).children[0]
    expect(alloc.figures.reserved).toBe(0)
    expect(alloc.children[0].kind).toBe('placeholder')
  })
})

describe('a new allocation with a staged reservation', () => {
  const groups = orderOf({ allocations: [{ _key: 'k-new', warehouseId: 'second', quantity: 30 }] })
  const staged: Partial<StagedChanges> = { creates: [{ key: 'c-1', alloc: { key: 'k-new' }, contactId: 'c2', quantity: 12 }] }
  const t = build(groups, { staged })
  const line = lineNode(t)
  const alloc = line.children[0]

  it('counts the staged reservation at once, on its warehouse, its line and the order', () => {
    expect(alloc.id).toBe('a:k-new')
    expect(alloc.figures).toMatchObject({ quantity: 30, reserved: 12, free: 18 })
    expect(line.figures.reserved).toBe(12)
    expect(t.totals.reserved).toBe(12)
  })

  it('marks it new, and says so on every parent that is closed over it', () => {
    const r = alloc.children[0]
    expect(r.id).toBe('r:new:c-1')
    expect(r.flags).toEqual(['new'])
    expect(r.status).toBeUndefined()
    expect(alloc.rolledFlags).toContain('new')
    expect(line.rolledFlags).toContain('new')
    expect(line.rolledFlags).toContain('unallocated')
  })

  it('opens what holds it, so a change nobody has saved is in sight', () => {
    expect(alloc.defaultOpen).toBe(true)
    expect(line.defaultOpen).toBe(true)
  })

  it('finds a staged reservation by the saved allocation\'s id as well, once the allocation has one', () => {
    const saved = build(
      orderOf({ allocations: [{ _id: 'A7', warehouseId: 'second', quantity: 30 }] }),
      { staged: { creates: [{ key: 'c-2', alloc: { id: 'A7' }, contactId: 'c1', quantity: 5 }] } },
    )
    expect(lineNode(saved).children[0].figures.reserved).toBe(5)
  })

  it('is what the Totals card now says: the server\'s reservations alone would have said 0', () => {
    const serverOnly = build(groups).totals.reserved
    expect(serverOnly).toBe(0)
    expect(t.totals.reserved).toBe(12)
  })
})

describe('a reservation staged to be cancelled', () => {
  const groups = orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }] })
  const reservations = [res({ _id: 'r1', quantity: 25, invoicedQuantity: 4, dispatchedQuantity: 8, allocationId: 'A1' })]

  it('counts as what a cancel cannot take back: the larger of invoiced and dispatched', () => {
    const t = build(groups, { reservations, staged: { cancels: ['r1'] } })
    const alloc = lineNode(t).children[0]
    const row = alloc.children[0]
    expect(row.reservation?.consumed).toBe(8)
    expect(countedQuantity(row.reservation!)).toBe(8)
    expect(row.figures.quantity).toBe(25) // what it says it was
    expect(row.figures.reserved).toBe(8) // what it still holds
    expect(alloc.figures).toMatchObject({ reserved: 8, free: 62 })
    expect(t.totals.reserved).toBe(8)
  })

  it('is flagged, offers its undo and nothing else, and says so on its parents', () => {
    const t = build(groups, { reservations, staged: { cancels: ['r1'] } })
    const alloc = lineNode(t).children[0]
    const row = alloc.children[0]
    expect(row.flags).toEqual(['cancelledOnSave'])
    expect(actionTypes(row)).toEqual(['undo'])
    expect(alloc.rolledFlags).toContain('cancelledOnSave')
    expect(row.reservation?.editable).toBe(false)
  })

  it('counts for nothing at all when nothing of it is invoiced or dispatched', () => {
    const t = build(groups, { reservations: [res({ _id: 'r2', quantity: 25, allocationId: 'A1' })], staged: { cancels: ['r2'] } })
    expect(lineNode(t).children[0].figures.reserved).toBe(0)
  })
})

describe('a reservation whose quantity or client is staged to change', () => {
  it('shows the new quantity, counts it, and is flagged changed', () => {
    const t = build(
      orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }] }),
      { reservations: [res({ _id: 'r1', quantity: 25, allocationId: 'A1' })], staged: { updates: { r1: { quantity: 30, contactId: 'c2' } } } },
    )
    const alloc = lineNode(t).children[0]
    const row = alloc.children[0]
    expect(row.figures.quantity).toBe(30)
    expect(row.label).toBe('Client B')
    expect(row.flags).toEqual(['changed'])
    expect(alloc.figures.reserved).toBe(30)
    expect(t.totals.reserved).toBe(30)
  })
})

describe('an allocation with received quantity', () => {
  const t = build(orderOf({ receivedQuantity: 6, allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70, receivedQuantity: 6 }] }))
  const line = lineNode(t)

  it('shows what arrived on the line and in the warehouse', () => {
    expect(line.figures.received).toBe(6)
    expect(line.children[0].figures.received).toBe(6)
    expect(t.groups[0].figures.received).toBe(6)
    expect(t.totals.received).toBe(6)
  })
})

describe('a line with no article', () => {
  const t = build([{ lines: [{ _id: 'L1', description: 'Carriage', quantity: 1, allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 1 }] }] }])
  const alloc = lineNode(t).children[0]

  it('can be given warehouses, but no client can be reserved on them', () => {
    expect(actionTypes(lineNode(t))).toContain('addWarehouse')
    expect(actionTypes(alloc)).toEqual(['remove'])
    expect(alloc.children[0].kind).toBe('placeholder')
    expect(alloc.children[0].actions).toEqual([])
  })
})

describe('an allocation with no warehouse chosen yet', () => {
  it('takes no client either', () => {
    const t = build(orderOf({ allocations: [{ _key: 'k1', warehouseId: '', quantity: 5 }] }))
    expect(actionTypes(lineNode(t).children[0])).toEqual(['remove'])
    expect(lineNode(t).children[0].label).toBe('—')
  })
})

describe('an order that cannot be changed', () => {
  const t = build(
    orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }] }),
    { readonly: true, reservations: [res({ _id: 'r1', allocationId: 'A1' })] },
  )
  const line = lineNode(t)

  it('offers no action anywhere, and nothing editable', () => {
    const all: TreeNode[] = []
    const walk = (n: TreeNode) => { all.push(n); n.children.forEach(walk) }
    walk(line)
    expect(all.length).toBeGreaterThan(2)
    for (const n of all) expect(n.actions).toEqual([])
    expect(line.children[0].children[0].reservation?.editable).toBe(false)
  })
})

describe('the row being added', () => {
  it('is the last child of its parent, and keeps the parent open', () => {
    const line = lineNode(build(orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 40 }] }), {
      adding: { parentId: 'l:L1', kind: 'allocation' },
    }))
    expect(line.defaultOpen).toBe(true)
    const last = line.children[line.children.length - 1]
    expect(last.kind).toBe('placeholder')
    expect(last.editing).toBe(true)
    expect(last.id).toBe('ed:l:L1')
    expect(last.placeholderOf).toBe('allocation')
  })

  it('replaces the "none yet" line instead of standing beside it', () => {
    const line = lineNode(build(orderOf(), { adding: { parentId: 'l:L1', kind: 'allocation' } }))
    expect(line.children).toHaveLength(1)
    expect(line.children[0].editing).toBe(true)
  })

  it('goes under a warehouse after its clients', () => {
    const t = build(
      orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }] }),
      { reservations: [res({ _id: 'r1', allocationId: 'A1' })], adding: { parentId: 'a:A1', kind: 'reservation' } },
    )
    const alloc = lineNode(t).children[0]
    expect(alloc.children.map((c) => c.kind)).toEqual(['reservation', 'placeholder'])
    expect(alloc.children[1].editing).toBe(true)
    expect(alloc.children[1].placeholderOf).toBe('reservation')
  })
})

describe('one set of figures', () => {
  const groups: GroupInput[] = [
    { _id: 'g1', lines: [
      { _id: 'L1', productId: 'p1', description: 'A', quantity: 100, allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }, { _key: 'kn', warehouseId: 'second', quantity: 30 }] },
      { _id: 'L2', productId: 'p2', description: 'B', quantity: 50, allocations: [{ _id: 'A2', warehouseId: 'main', quantity: 50 }] },
    ] },
    { _id: 'g2', lines: [{ _id: 'L3', productId: 'p3', description: 'C', quantity: 10, allocations: [] }] },
  ]
  const reservations = [res({ _id: 'r1', quantity: 25, allocationId: 'A1' }), res({ _id: 'r2', quantity: 20, allocationId: 'A2', invoicedQuantity: 5 })]
  const staged: Partial<StagedChanges> = { creates: [{ key: 'c1', alloc: { key: 'kn' }, contactId: 'c3', quantity: 10 }] }
  const t = build(groups, { reservations, staged })

  it('has the Totals card equal what the lines say, whatever is staged', () => {
    const lineReserved = t.groups.flatMap((g) => g.nodes).reduce((s, n) => s + n.figures.reserved, 0)
    expect(t.totals.reserved).toBe(lineReserved)
    expect(t.totals.reserved).toBe(25 + 20 + 10)
    expect(t.totals.ordered).toBe(160)
    expect(t.totals.invoiced).toBe(5)
  })

  it('has a parent equal what its children add up to, at every level', () => {
    const check = (n: TreeNode) => {
      if (n.kind === 'placeholder') return
      if (n.children.length && n.children.some((c) => c.kind !== 'placeholder')) {
        const kids = n.children.filter((c) => c.kind !== 'placeholder')
        expect(n.figures.reserved).toBe(kids.reduce((s, c) => s + c.figures.reserved, 0))
        expect(n.figures.invoiced).toBe(kids.reduce((s, c) => s + c.figures.invoiced, 0))
        expect(n.figures.dispatched).toBe(kids.reduce((s, c) => s + c.figures.dispatched, 0))
      }
      n.children.forEach(check)
    }
    t.groups.flatMap((g) => g.nodes).forEach(check)
  })

  it('keeps the order of the lines and indexes every node by its id', () => {
    expect(t.groups.map((g) => g.nodes.map((n) => n.label))).toEqual([['A', 'B'], ['C']])
    expect(t.index.get('l:L2')?.label).toBe('B')
    expect(t.index.get('a:kn')?.label).toBe('Second')
    expect(t.index.get('r:new:c1')?.label).toBe('Client C')
    expect(lineNodeId(groups[0].lines[0], 0, 0)).toBe('l:L1')
    expect(allocationNodeId(groups[0].lines[0].allocations[1], 0, 0, 1)).toBe('a:kn')
  })
})

describe('flags', () => {
  it('merge without repeats, in the order they are shown', () => {
    expect(mergeFlags(['new', 'overAllocated'], ['new'], ['unallocated'])).toEqual(['overAllocated', 'unallocated', 'new'])
  })
  it('open a row when they are about the order\'s state of repair, and not when they only inform', () => {
    expect(needsAttention(['unallocated'])).toBe(false)
    expect(needsAttention(['unallocated', 'cancelledOnSave'])).toBe(true)
    expect(needsAttention([])).toBe(false)
  })
})

describe('what is showing, and what opens and closes it', () => {
  const groups = orderOf({ allocations: [{ _id: 'A1', warehouseId: 'main', quantity: 70 }, { _id: 'A2', warehouseId: 'second', quantity: 30 }] })
  const reservations = [res({ _id: 'r1', allocationId: 'A1' })]
  const t = build(groups, { reservations })
  const roots = t.groups[0].nodes
  const ids = (rows: ReturnType<typeof visibleRows>) => rows.map((r) => r.node.id)

  it('shows what the data says opens: the line and the warehouse that holds a client, not the empty one', () => {
    const rows = visibleRows(roots, {})
    expect(ids(rows)).toEqual(['l:L1', 'a:A1', 'r:r1', 'a:A2'])
    expect(rows.find((r) => r.node.id === 'a:A2')?.open).toBe(false)
    expect(rows.find((r) => r.node.id === 'a:A2')?.expandable).toBe(true) // its placeholder
  })

  it('lets the user\'s choice win, either way, and keeps it while the data changes under it', () => {
    const closed = { 'l:L1': false }
    expect(ids(visibleRows(roots, closed))).toEqual(['l:L1'])
    expect(isNodeOpen(roots[0], closed)).toBe(false)
    const opened = { 'a:A2': true }
    expect(ids(visibleRows(roots, opened))).toEqual(['l:L1', 'a:A1', 'r:r1', 'a:A2', 'ph:a:A2:reservation'])
    expect(toggled({}, roots[0])).toEqual({ 'l:L1': false })
    expect(toggled({ 'l:L1': false }, roots[0])).toEqual({ 'l:L1': true })
  })

  it('opens and closes every row below a supplier\'s lines at once', () => {
    expect(parentIds(roots)).toEqual(['l:L1', 'a:A1', 'a:A2'])
    const all = visibleRows(roots, expandAll({}, roots))
    expect(ids(all)).toEqual(['l:L1', 'a:A1', 'r:r1', 'a:A2', 'ph:a:A2:reservation'])
    expect(ids(visibleRows(roots, collapseAll({}, roots)))).toEqual(['l:L1'])
  })

  it('opens the way to a row a link points at', () => {
    expect(ancestorIds(t.index, 'r:r1')).toEqual(['l:L1', 'a:A1'])
    const shown = visibleRows(roots, revealed({ 'l:L1': false, 'a:A1': false }, t.index, 'r:r1'))
    expect(ids(shown)).toContain('r:r1')
    expect(ancestorIds(t.index, 'l:L1')).toEqual([])
    expect(ancestorIds(t.index, 'nope')).toEqual([])
  })

  it('opens the row itself too when asked, for a link that names the warehouse', () => {
    const state = revealed({ 'a:A2': false }, t.index, 'a:A2', true)
    expect(state['a:A2']).toBe(true)
  })

  it('leaves a row with no children (a reservation) alone', () => {
    const state = revealed({}, t.index, 'r:r1', true)
    expect(state['r:r1']).toBeUndefined()
  })
})
