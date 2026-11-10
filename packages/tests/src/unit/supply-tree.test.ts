import { describe, it, expect } from 'bun:test'
// PURE modules: no Vue, no store. `invoicing-ui` is not a workspace package, so they are reached by path.
import { buildSupplyTree, supplyAllocationNodeId, supplyLineNodeId, supplyReservationNodeId, supplyStockNodeId } from '../../../invoicing-ui/src/composables/order-tree/supply-tree'
import { isNodeOpen, visibleRows } from '../../../invoicing-ui/src/composables/order-tree/tree-rows'
import type { ServerReservation, SupplyInput } from '../../../invoicing-ui/src/composables/order-tree/types'

/**
 * FR-28.45 — where a reservation sits: the supply it hangs on, with every reservation on it.
 *
 * A supplier order's line, its warehouses and the reservations on each; or one warehouse's free stock and the
 * reservations on it. This reservation is always a row, highlighted by the page; the others show a client and a
 * quantity.
 */

const LINE = '6a0000000000000000000a01'
const A1 = '6a0000000000000000000d01'
const A2 = '6a0000000000000000000d02'
const WH1 = '6a0000000000000000000e01'
const WH2 = '6a0000000000000000000e02'

const names: Record<string, string> = { c1: 'Client A', c2: 'Client B', c3: 'Client C' }
const contactName = (id: string) => names[id] || ''

function res(over: Partial<ServerReservation> & { _id: string }): ServerReservation {
  return {
    reservationNumber: `RES-${over._id.slice(-2)}`,
    status: 'active',
    contactId: 'c1',
    quantity: 10,
    invoicedQuantity: 0,
    dispatchedQuantity: 0,
    source: 'order',
    warehouseId: WH1,
    allocationId: A1,
    ...over,
  }
}

function orderSupply(reservations: ServerReservation[], over: Partial<SupplyInput> = {}): SupplyInput {
  return {
    kind: 'order',
    line: { _id: LINE, description: 'Hex bolt M8', quantity: 100, receivedQuantity: 20 },
    allocations: [
      { _id: A1, warehouseId: WH1, warehouseName: 'Main', quantity: 70, receivedQuantity: 20 },
      { _id: A2, warehouseId: WH2, warehouseName: 'Second', quantity: 30, receivedQuantity: 0 },
    ],
    reservations,
    ...over,
  }
}

const stockSupply = (reservations: ServerReservation[]): SupplyInput => ({
  kind: 'stock',
  warehouse: { _id: WH1, name: 'Main', onHand: 50, available: 28 },
  reservations,
})

describe('a reservation on a supplier order', () => {
  const rs = [
    res({ _id: 'aa01', quantity: 25, contactId: 'c1', invoicedQuantity: 10 }),
    res({ _id: 'aa02', quantity: 15, contactId: 'c2' }),
    res({ _id: 'aa03', quantity: 20, contactId: 'c3', allocationId: A2, warehouseId: WH2 }),
  ]

  it('is the order\'s line, each warehouse and the reservations on it, this one marked', () => {
    const t = buildSupplyTree(orderSupply(rs), { contactName, thisId: 'aa02' })
    expect(t.nodes).toHaveLength(1)
    const line = t.nodes[0]
    expect(line).toMatchObject({ id: supplyLineNodeId(LINE), kind: 'line', depth: 0, label: 'Hex bolt M8' })
    expect(line.children.map((c) => [c.kind, c.label, c.depth])).toEqual([['allocation', 'Main', 1], ['allocation', 'Second', 1]])
    const main = line.children[0]
    expect(main.children.map((c) => [c.kind, c.label, c.depth, c.reservation!.number])).toEqual([
      ['reservation', 'Client A', 2, 'RES-01'],
      ['reservation', 'Client B', 2, 'RES-02'],
    ])
    expect(t.thisNodeId).toBe(supplyReservationNodeId('aa02'))
    expect(t.index.get(t.thisNodeId)!.reservation!.resId).toBe('aa02')
    expect(t.rows).toBe(3)
  })

  it('every level adds up its children, in the supplier order\'s columns', () => {
    const t = buildSupplyTree(orderSupply(rs), { contactName, thisId: 'aa02' })
    const line = t.nodes[0]
    const [main, second] = line.children
    // Main: 70 allocated, 40 reserved (25 + 15), 30 free, 20 received, 10 invoiced.
    expect(main.figures).toEqual({ quantity: 70, reserved: 40, free: 30, received: 20, invoiced: 10, dispatched: 0 })
    expect(second.figures).toEqual({ quantity: 30, reserved: 20, free: 10, received: 0, invoiced: 0, dispatched: 0 })
    // The line: 100 ordered, 60 reserved on its two warehouses, and 0 still to place (70 + 30 = 100).
    expect(line.figures).toEqual({ quantity: 100, reserved: 60, free: 0, received: 20, invoiced: 10, dispatched: 0 })
    // A reservation: its own quantity, held, invoiced.
    expect(main.children[0].figures).toEqual({ quantity: 25, reserved: 25, free: null, received: null, invoiced: 10, dispatched: 0 })
  })

  it('opens on what it shows: the line and the warehouses that hold reservations, not an empty one', () => {
    const t = buildSupplyTree(orderSupply([res({ _id: 'aa01' })]), { contactName, thisId: 'aa01' })
    const line = t.nodes[0]
    const [main, second] = line.children
    expect(isNodeOpen(line, {})).toBe(true)
    expect(isNodeOpen(main, {})).toBe(true)
    // Second holds nothing: one muted row, closed until someone asks.
    expect(isNodeOpen(second, {})).toBe(false)
    expect(second.children).toHaveLength(1)
    expect(second.children[0]).toMatchObject({ kind: 'placeholder', placeholderOf: 'reservation' })
    // So this reservation is on screen without a click.
    expect(visibleRows(t.nodes, {}).map((r) => r.node.id)).toContain(supplyReservationNodeId('aa01'))
  })

  it('leaves out the other reservations that are cancelled, but keeps this one, which holds nothing', () => {
    const list = [
      res({ _id: 'aa01', quantity: 25 }),
      res({ _id: 'aa02', quantity: 15, status: 'cancelled' }),
      res({ _id: 'aa03', quantity: 5, status: 'cancelled' }),
    ]
    const t = buildSupplyTree(orderSupply(list), { contactName, thisId: 'aa03' })
    const ids = [...t.index.values()].filter((n) => n.kind === 'reservation').map((n) => n.reservation!.resId)
    expect(ids).toEqual(['aa01', 'aa03'])
    expect(t.thisNodeId).toBe(supplyReservationNodeId('aa03'))
    expect(t.index.get(t.thisNodeId)!.status).toBe('cancelled')
    expect(t.index.get(t.thisNodeId)!.figures).toMatchObject({ quantity: 5, reserved: 0 })
    // The warehouse adds up what is held: 25, not 45.
    expect(t.nodes[0].children[0].figures.reserved).toBe(25)
  })

  it('a fulfilled reservation counts, and says so', () => {
    const t = buildSupplyTree(orderSupply([res({ _id: 'aa01', quantity: 12, status: 'fulfilled', invoicedQuantity: 12, dispatchedQuantity: 12 })]), { contactName, thisId: 'aa01' })
    expect(t.nodes[0].children[0].figures).toMatchObject({ reserved: 12, invoiced: 12, dispatched: 12 })
    expect(t.index.get(t.thisNodeId)!.status).toBe('fulfilled')
  })

  it('names the client the server named, else the form\'s own label, else a dash', () => {
    const t = buildSupplyTree(orderSupply([
      res({ _id: 'aa01', contactId: 'c1', contactName: 'Named By Server' }),
      res({ _id: 'aa02', contactId: 'c2' }),
      res({ _id: 'aa03', contactId: 'zz' }),
    ]), { contactName, thisId: 'aa01' })
    expect(t.nodes[0].children[0].children.map((c) => c.label)).toEqual(['Named By Server', 'Client B', '—'])
  })

  it('says what is wrong with the line: over-allocated, or not yet placed', () => {
    const over = buildSupplyTree(orderSupply([res({ _id: 'aa01' })], { line: { _id: LINE, description: 'x', quantity: 80, receivedQuantity: 0 } }), { contactName, thisId: 'aa01' })
    expect(over.nodes[0].flags).toEqual(['overAllocated'])
    expect(over.nodes[0].figures.free).toBe(0)
    const part = buildSupplyTree(orderSupply([res({ _id: 'aa01' })], { line: { _id: LINE, description: 'x', quantity: 130, receivedQuantity: 0 } }), { contactName, thisId: 'aa01' })
    expect(part.nodes[0].flags).toEqual(['unallocated'])
    expect(part.nodes[0].figures.free).toBe(30)
  })

  it('has no action on any row: the page only reads', () => {
    const t = buildSupplyTree(orderSupply(rs), { contactName, thisId: 'aa01' })
    expect([...t.index.values()].every((n) => n.actions.length === 0)).toBe(true)
    expect([...t.index.values()].filter((n) => n.kind === 'reservation').every((n) => n.reservation!.editable === false)).toBe(true)
  })

  it('a reservation whose warehouse is gone from the order is not a row, and nothing is marked', () => {
    const t = buildSupplyTree(orderSupply([res({ _id: 'aa01', allocationId: 'gone' })]), { contactName, thisId: 'aa01' })
    expect(t.thisNodeId).toBe('')
    expect(t.rows).toBe(0)
  })

  it('without a line there is no tree', () => {
    const t = buildSupplyTree({ kind: 'order', reservations: [res({ _id: 'aa01' })] }, { contactName, thisId: 'aa01' })
    expect(t.nodes).toEqual([])
    expect(t.thisNodeId).toBe('')
  })
})

describe('a reservation on free stock', () => {
  it('is the warehouse and the reservations on its stock, this one marked', () => {
    const rs = [
      res({ _id: 'bb01', source: 'stock', allocationId: undefined, quantity: 12, contactId: 'c1' }),
      res({ _id: 'bb02', source: 'stock', allocationId: undefined, quantity: 10, contactId: 'c2', dispatchedQuantity: 4 }),
    ]
    const t = buildSupplyTree(stockSupply(rs), { contactName, thisId: 'bb02' })
    expect(t.nodes).toHaveLength(1)
    const w = t.nodes[0]
    expect(w).toMatchObject({ id: supplyStockNodeId(WH1), kind: 'allocation', depth: 0, label: 'Main', defaultOpen: true })
    // On the shelf 50; these reservations hold 22; the server says 28 can still be taken (other holds count there).
    expect(w.figures).toEqual({ quantity: 50, reserved: 22, free: 28, received: null, invoiced: 0, dispatched: 4 })
    expect(w.children.map((c) => [c.label, c.depth, c.figures.quantity])).toEqual([['Client A', 1, 12], ['Client B', 1, 10]])
    expect(t.thisNodeId).toBe(supplyReservationNodeId('bb02'))
    expect(visibleRows(t.nodes, {}).map((r) => r.node.id)).toEqual([supplyStockNodeId(WH1), supplyReservationNodeId('bb01'), supplyReservationNodeId('bb02')])
  })

  it('a cancelled reservation is the only row of its stock, and holds nothing', () => {
    const t = buildSupplyTree(stockSupply([res({ _id: 'bb01', source: 'stock', allocationId: undefined, status: 'cancelled', quantity: 4 })]), { contactName, thisId: 'bb01' })
    expect(t.nodes[0].figures).toMatchObject({ reserved: 0, free: 28 })
    expect(t.index.get(t.thisNodeId)!.figures).toMatchObject({ quantity: 4, reserved: 0 })
  })

  it('a warehouse with no reservation shows one muted row', () => {
    const t = buildSupplyTree(stockSupply([]), { contactName, thisId: 'none' })
    expect(t.nodes[0].children).toHaveLength(1)
    expect(t.nodes[0].children[0].kind).toBe('placeholder')
    expect(t.thisNodeId).toBe('')
  })

  it('never shows less than nothing free', () => {
    const t = buildSupplyTree({ kind: 'stock', warehouse: { _id: WH1, name: 'Main', onHand: 5, available: -2 }, reservations: [] }, { contactName, thisId: 'x' })
    expect(t.nodes[0].figures.free).toBe(0)
  })
})

describe('the ids', () => {
  it('are the supplier order\'s own, so one deep link and one open state serve both', () => {
    expect(supplyLineNodeId(LINE)).toBe(`l:${LINE}`)
    expect(supplyAllocationNodeId(A1)).toBe(`a:${A1}`)
    expect(supplyReservationNodeId('aa01')).toBe('r:aa01')
  })
})
