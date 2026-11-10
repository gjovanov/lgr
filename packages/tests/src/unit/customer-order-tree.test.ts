import { describe, it, expect } from 'bun:test'
// PURE modules: no Vue, no store. `invoicing-ui` is not a workspace package, so they are reached by path.
import { buildCustomerOrderTree, customerLineNodeId, customerReservationNodeId } from '../../../invoicing-ui/src/composables/order-tree/customer-order-tree'
import { dayOf, heldQuantity, isLateReservation, reservationRowFrom } from '../../../invoicing-ui/src/composables/order-tree/figures'
import { internalOrderLineQuery, orderLineQuery } from '../../../invoicing-ui/src/composables/order-tree/links'
import { isNodeOpen, revealed, toggled, visibleRows } from '../../../invoicing-ui/src/composables/order-tree/tree-rows'
import type {
  CustomerLineInput,
  CustomerLineServerFigures,
  ServerReservation,
  TreeNode,
} from '../../../invoicing-ui/src/composables/order-tree/types'

/**
 * FR-28.44 — the customer order's lines and their reservations as a tree of two levels.
 *
 * The cases the brief names: a line with no reservation, partial, fully covered, over-reserved, cancelled and
 * fulfilled reservations, a reservation from stock against one from a supplier order, late lines
 * (`requestedDeliveryDate`), and the figures at each level.
 */

const L1 = '6a0000000000000000000a01'
const L2 = '6a0000000000000000000a02'
const ORDI = '6a0000000000000000000b01'
const ORDO = '6a0000000000000000000c01'
const ALLOC = '6a0000000000000000000d01'
const WH = '6a0000000000000000000e01'

function line(over: Partial<CustomerLineInput> = {}): CustomerLineInput {
  return { _id: L1, productId: 'p1', description: 'Hex bolt M8', quantity: 10, ...over }
}

function res(over: Partial<ServerReservation> & { _id: string }): ServerReservation {
  return {
    reservationNumber: `RES-${over._id.slice(-4)}`,
    status: 'active',
    contactId: 'c1',
    quantity: 4,
    invoicedQuantity: 0,
    dispatchedQuantity: 0,
    source: 'stock',
    warehouseId: WH,
    internalOrderId: ORDI,
    internalOrderLineId: L1,
    ...over,
  }
}

const server = (over: Partial<Record<string, CustomerLineServerFigures>> = {}) =>
  ({ [L1]: { onUnsentOrder: 0, invoiced: 0, delivered: 0 }, ...over }) as Record<string, CustomerLineServerFigures>

function build(
  lines: CustomerLineInput[],
  reservations: ServerReservation[] = [],
  opts: { readonly?: boolean; canReserve?: boolean; requestedDeliveryDate?: string; server?: Record<string, CustomerLineServerFigures> } = {},
) {
  return buildCustomerOrderTree(lines, reservations, {
    readonly: opts.readonly ?? false,
    canReserve: opts.canReserve ?? true,
    requestedDeliveryDate: opts.requestedDeliveryDate,
    server: opts.server ?? server(),
  })
}

const lineNode = (t: ReturnType<typeof build>, id = L1) => t.index.get(`l:${id}`)!
const kids = (n: TreeNode) => n.children.filter((c) => c.kind === 'reservation')

describe('a line with no reservation', () => {
  it('says what is short, offers + Reserve, and holds one muted row for it', () => {
    const t = build([line()])
    const n = lineNode(t)
    expect(n.figures).toEqual({ quantity: 10, reserved: 0, free: 10, received: null, invoiced: 0, dispatched: 0 })
    expect(n.coverage).toEqual({ status: 'none', onUnsentOrder: 0 })
    expect(n.actions.map((a) => a.type)).toEqual(['reserve', 'remove'])
    expect(n.actions[0].disabled).toBe(false)
    // An empty parent shows one muted row with its +, as the supplier order's does (FR-28.42).
    expect(n.children).toHaveLength(1)
    expect(n.children[0]).toMatchObject({ kind: 'placeholder', placeholderOf: 'reservation', depth: 1 })
    expect(n.children[0].actions.map((a) => a.type)).toEqual(['reserve'])
    // Nothing below needs a look: it stays closed until someone opens it.
    expect(n.defaultOpen).toBe(false)
    expect(n.flags).toEqual([])
  })

  it('is just a row where a reservation cannot be made: a draft order, an unsaved line, a line without an article', () => {
    // The order is not confirmed yet.
    const draft = lineNode(build([line()], [], { canReserve: false }))
    expect(draft.children).toEqual([])
    expect(draft.actions.map((a) => a.type)).toEqual(['remove'])
    // A line that has never been saved has no id the reservation could name.
    const t = build([line({ _id: undefined })])
    const n = t.nodes[0]
    expect(n.id).toBe('l:0.0')
    expect(n.children).toEqual([])
    expect(n.actions.map((a) => a.type)).toEqual(['remove'])
    expect(n.coverage).toBeUndefined()
    // No article: nothing to reserve.
    expect(lineNode(build([line({ productId: undefined })])).actions.map((a) => a.type)).toEqual(['remove'])
  })

  it('takes every action away from a closed order', () => {
    const t = build([line()], [res({ _id: `${ORDO.slice(0, -4)}0001` })], { readonly: true, canReserve: false })
    const n = lineNode(t)
    expect(n.actions).toEqual([])
    expect(kids(n)[0].actions).toEqual([])
    expect(kids(n)[0].reservation!.editable).toBe(false)
  })
})

describe('partial and full cover', () => {
  it('partly reserved: the figures follow the rows, and the line opens on its own', () => {
    const t = build([line()], [res({ _id: 'aaaa00000000000000000001', quantity: 4 })])
    const n = lineNode(t)
    expect(n.figures).toMatchObject({ quantity: 10, reserved: 4, free: 6 })
    expect(n.coverage?.status).toBe('partial')
    expect(n.defaultOpen).toBe(true)
    expect(kids(n)).toHaveLength(1)
    expect(kids(n)[0].figures).toEqual({ quantity: 4, reserved: 4, free: null, received: null, invoiced: 0, dispatched: 0 })
    expect(n.actions[0]).toEqual({ type: 'reserve', disabled: false })
  })

  it('fully covered: nothing short, and + Reserve is there but cannot be pressed', () => {
    const t = build([line()], [
      res({ _id: 'aaaa00000000000000000001', quantity: 4 }),
      res({ _id: 'aaaa00000000000000000002', quantity: 6 }),
    ])
    const n = lineNode(t)
    expect(n.figures).toMatchObject({ reserved: 10, free: 0 })
    expect(n.coverage?.status).toBe('full')
    expect(n.actions[0]).toEqual({ type: 'reserve', disabled: true })
    expect(n.flags).toEqual([])
  })

  it('ordered: all of it reserved, some only on a supplier order not sent yet (FR-22.44)', () => {
    const t = build([line()], [res({ _id: 'aaaa00000000000000000001', quantity: 10, source: 'order', orderId: ORDO })], {
      server: server({ [L1]: { onUnsentOrder: 4, invoiced: 0, delivered: 0 } }),
    })
    expect(lineNode(t).coverage).toEqual({ status: 'ordered', onUnsentOrder: 4 })
  })

  it('over-reserved: a quantity edited below what is held flags the line and opens it', () => {
    // The form holds 6 while the server holds 10 for the line: a save would be refused, so the row says so now.
    const t = build([line({ quantity: 6 })], [res({ _id: 'aaaa00000000000000000001', quantity: 10 })])
    const n = lineNode(t)
    expect(n.figures).toMatchObject({ quantity: 6, reserved: 10, free: 0 })
    expect(n.flags).toEqual(['overReserved'])
    expect(n.rolledFlags).toEqual(['overReserved'])
    expect(n.defaultOpen).toBe(true)
    expect(n.coverage?.status).toBe('full')
  })

  it('a quantity typed over the line moves the figures at once, with no round trip', () => {
    const rs = [res({ _id: 'aaaa00000000000000000001', quantity: 4 })]
    expect(lineNode(build([line({ quantity: 10 })], rs)).figures.free).toBe(6)
    expect(lineNode(build([line({ quantity: 20 })], rs)).figures.free).toBe(16)
    expect(lineNode(build([line({ quantity: 3 })], rs)).flags).toEqual(['overReserved'])
  })
})

describe('cancelled and fulfilled reservations', () => {
  it('a cancelled one is a row that holds nothing and can be made again; a fulfilled one still counts', () => {
    const t = build([line()], [
      res({ _id: 'aaaa00000000000000000001', quantity: 3, status: 'cancelled' }),
      res({ _id: 'aaaa00000000000000000002', quantity: 5, status: 'fulfilled', invoicedQuantity: 5, dispatchedQuantity: 5 }),
    ])
    const n = lineNode(t)
    const [cancelled, fulfilled] = kids(n)
    expect(cancelled.status).toBe('cancelled')
    // Its quantity is kept for the record; what it holds is nothing.
    expect(cancelled.figures).toMatchObject({ quantity: 3, reserved: 0 })
    expect(cancelled.actions.map((a) => a.type)).toEqual(['reserveAgain'])
    expect(fulfilled.status).toBe('fulfilled')
    expect(fulfilled.figures).toMatchObject({ quantity: 5, reserved: 5, invoiced: 5, dispatched: 5 })
    // Neither is edited or released: there is nothing left to hold or give back.
    expect(fulfilled.actions).toEqual([])
    // The line adds up what is held: 5, not 8.
    expect(n.figures).toMatchObject({ reserved: 5, free: 5 })
    // Both are rows, so the line opens on them, as the sub-row it replaces always showed them.
    expect(n.defaultOpen).toBe(true)
    expect(n.children).toHaveLength(2)
  })

  it('"Reserve again" is offered only while the order can still be served', () => {
    const cancelled = res({ _id: 'aaaa00000000000000000001', status: 'cancelled' })
    expect(kids(lineNode(build([line()], [cancelled], { canReserve: true })))[0].actions.map((a) => a.type)).toEqual(['reserveAgain'])
    expect(kids(lineNode(build([line()], [cancelled], { canReserve: false })))[0].actions).toEqual([])
  })

  it('an active reservation can be changed and released; the quantity dialog and the release dialog are its two actions', () => {
    const n = lineNode(build([line()], [res({ _id: 'aaaa00000000000000000001' })]))
    expect(kids(n)[0].actions.map((a) => a.type)).toEqual(['editQuantity', 'release'])
    expect(kids(n)[0].reservation).toMatchObject({ editable: true, cancellable: true, cancelled: false, changed: false })
  })
})

describe('a reservation from stock against one from a supplier order', () => {
  it('each says where it comes from, and the order one knows the line and warehouse to link to', () => {
    const t = build([line()], [
      res({ _id: 'aaaa00000000000000000001', quantity: 4, source: 'stock' }),
      res({
        _id: 'aaaa00000000000000000002', quantity: 6, source: 'order', orderId: ORDO, lineId: 'bbbb00000000000000000001', allocationId: ALLOC, expectedDate: '2026-12-01T00:00:00.000Z',
      }),
    ])
    const [stock, order] = kids(lineNode(t))
    expect(stock.reservation).toMatchObject({ source: 'stock', warehouseId: WH, orderId: undefined, allocationId: undefined })
    expect(order.reservation).toMatchObject({ source: 'order', orderId: ORDO, orderLineId: 'bbbb00000000000000000001', allocationId: ALLOC, expectedDate: '2026-12-01' })
    // The link a supplier order's chip gets (FR-28.46).
    expect(orderLineQuery({ lineId: order.reservation!.orderLineId, allocationId: order.reservation!.allocationId })).toEqual({ line: 'bbbb00000000000000000001', allocation: ALLOC })
    // The customer order's own line is what a link back to it names.
    expect(internalOrderLineQuery(order.reservation)).toEqual({ line: L1 })
  })
})

describe('late', () => {
  const onOrder = (over: Partial<ServerReservation>) => res({ _id: 'aaaa00000000000000000001', source: 'order', orderId: ORDO, expectedDate: '2026-12-20T00:00:00.000Z', ...over })

  it('a reservation whose supplier order is expected after the requested date is late, and its line says so while closed', () => {
    const t = build([line()], [onOrder({})], { requestedDeliveryDate: '2026-12-15' })
    const n = lineNode(t)
    expect(kids(n)[0].flags).toEqual(['late'])
    expect(kids(n)[0].reservation!.late).toBe(true)
    // Not the line's own flag, but what a closed line still says about what is below it.
    expect(n.flags).toEqual([])
    expect(n.rolledFlags).toEqual(['late'])
    expect(n.defaultOpen).toBe(true)
  })

  it('not late: on the day, before it, with no requested date, on stock, or once it is history', () => {
    const flagged = (r: ServerReservation, requested?: string) => kids(lineNode(build([line()], [r], { requestedDeliveryDate: requested })))[0].flags
    expect(flagged(onOrder({ expectedDate: '2026-12-15T00:00:00.000Z' }), '2026-12-15')).toEqual([])
    expect(flagged(onOrder({ expectedDate: '2026-12-01T00:00:00.000Z' }), '2026-12-15')).toEqual([])
    expect(flagged(onOrder({}), undefined)).toEqual([])
    expect(flagged(res({ _id: 'aaaa00000000000000000001', source: 'stock' }), '2026-12-15')).toEqual([])
    expect(flagged(onOrder({ status: 'fulfilled' }), '2026-12-15')).toEqual([])
    expect(flagged(onOrder({ status: 'cancelled' }), '2026-12-15')).toEqual([])
  })

  it('reads dates the way the server sends them: a string, a Date, or nothing', () => {
    expect(dayOf('2026-12-15T22:00:00.000Z')).toBe('2026-12-15')
    expect(dayOf(new Date('2026-12-15T10:00:00Z'))).toBe('2026-12-15')
    expect(dayOf(null)).toBe('')
    expect(dayOf(undefined)).toBe('')
    expect(dayOf(new Date('nonsense'))).toBe('')
    expect(isLateReservation({ status: 'active', expectedDate: new Date('2026-12-16T00:00:00Z') }, '2026-12-15')).toBe(true)
  })
})

describe('the figures at each level', () => {
  it('a line takes its invoiced and delivered from the server; a reservation has its own', () => {
    const t = build(
      [line()],
      [
        res({ _id: 'aaaa00000000000000000001', quantity: 6, invoicedQuantity: 4, dispatchedQuantity: 2 }),
        res({ _id: 'aaaa00000000000000000002', quantity: 4, invoicedQuantity: 0, dispatchedQuantity: 0 }),
      ],
      // An invoice can name the line without naming a reservation: 5 invoiced, though the reservations say 4.
      { server: server({ [L1]: { onUnsentOrder: 0, invoiced: 5, delivered: 2 } }) },
    )
    const n = lineNode(t)
    expect(n.figures).toEqual({ quantity: 10, reserved: 10, free: 0, received: null, invoiced: 5, dispatched: 2 })
    const [a, b] = kids(n)
    expect(a.figures).toMatchObject({ quantity: 6, invoiced: 4, dispatched: 2 })
    expect(b.figures).toMatchObject({ quantity: 4, invoiced: 0, dispatched: 0 })
    expect(a.reservation).toMatchObject({ invoiced: 4, dispatched: 2, consumed: 4 })
  })

  it('the order\'s totals add the lines up: ordered, reserved, short, invoiced, delivered; a blank line is not a line', () => {
    const t = build(
      [line(), line({ _id: L2, description: 'Washer', quantity: 5 }), line({ _id: undefined, productId: undefined, description: '', quantity: 0 })],
      [res({ _id: 'aaaa00000000000000000001', quantity: 4 }), res({ _id: 'aaaa00000000000000000002', quantity: 5, internalOrderLineId: L2 })],
      { server: server({ [L2]: { onUnsentOrder: 0, invoiced: 1, delivered: 1 } }) },
    )
    expect(t.totals).toEqual({ lines: 2, ordered: 15, reserved: 9, short: 6, invoiced: 1, delivered: 1 })
    // Another line's reservation stays under its own line.
    expect(kids(lineNode(t, L1))).toHaveLength(1)
    expect(kids(lineNode(t, L2))).toHaveLength(1)
  })

  it('a reservation that serves no line of this order is not a row (the flat card lists it)', () => {
    const t = build([line()], [res({ _id: 'aaaa00000000000000000001', internalOrderLineId: 'ffff00000000000000000001' }), res({ _id: 'aaaa00000000000000000002', internalOrderLineId: undefined })])
    expect(kids(lineNode(t))).toHaveLength(0)
    expect(lineNode(t).figures.reserved).toBe(0)
  })

  it('nothing is staged: no row is new, changed or cancelled on save', () => {
    const n = lineNode(build([line()], [res({ _id: 'aaaa00000000000000000001' })]))
    expect(kids(n)[0].reservation).toMatchObject({ cancelled: false, changed: false, canChangeClient: false })
  })

  it('heldQuantity is the server\'s rule: a cancelled reservation holds nothing, any other holds its quantity', () => {
    expect(heldQuantity({ status: 'active', quantity: 4 })).toBe(4)
    expect(heldQuantity({ status: 'fulfilled', quantity: 4 })).toBe(4)
    expect(heldQuantity({ status: 'cancelled', quantity: 4 })).toBe(0)
    expect(heldQuantity({ status: 'active', quantity: undefined })).toBe(0)
  })

  it('a row is built from what the server sends, with ids as strings', () => {
    const row = reservationRowFrom(res({ _id: 'aaaa00000000000000000001', quantity: 3, invoicedQuantity: 1, dispatchedQuantity: 2 }), { readonly: false })
    expect(row).toMatchObject({ key: 'aaaa00000000000000000001', resId: 'aaaa00000000000000000001', status: 'active', quantity: 3, invoiced: 1, dispatched: 2, consumed: 2, internalOrderId: ORDI })
  })
})

describe('what is open (FR-28.42, by the same rules as the supplier order)', () => {
  it('a line with reservations is open, the others closed; a user\'s choice then wins over what the data says', () => {
    const t = build([line(), line({ _id: L2, description: 'Washer' })], [res({ _id: 'aaaa00000000000000000001' })])
    const [a, b] = t.nodes
    expect(isNodeOpen(a, {})).toBe(true)
    expect(isNodeOpen(b, {})).toBe(false)
    expect(visibleRows(t.nodes, {}).map((r) => r.node.id)).toEqual([a.id, customerReservationNodeId('aaaa00000000000000000001'), b.id])
    const closed = toggled({}, a)
    expect(visibleRows(t.nodes, closed).map((r) => r.node.id)).toEqual([a.id, b.id])
    // A row asked for by a link opens the way to itself.
    const open = revealed({}, t.index, customerReservationNodeId('aaaa00000000000000000001'))
    expect(open[a.id]).toBe(true)
  })

  it('a node id is what a deep link names: the line\'s own id, so a link and the tree agree', () => {
    expect(customerLineNodeId(line(), 0)).toBe(`l:${L1}`)
    expect(customerLineNodeId(line({ _id: undefined }), 3)).toBe('l:0.3')
    expect(internalOrderLineQuery({ internalOrderLineId: L1 })).toEqual({ line: L1 })
    // An id that is not there gives no query: the link opens the form as usual.
    expect(internalOrderLineQuery({})).toBeUndefined()
    expect(internalOrderLineQuery(null)).toBeUndefined()
    expect(build([line()]).index.get('l:nothing')).toBeUndefined()
  })
})
