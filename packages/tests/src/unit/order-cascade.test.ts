import { describe, it, expect } from 'bun:test'
import { cascadeSummary } from '../../../invoicing-ui/src/composables/order-cascade'

/**
 * FR-22.41 — what cancelling or completing an order releases, said before it happens. The count
 * follows the server's cascades: a reservation that is cancelled already, or has nothing left
 * once invoiced or dispatched quantities are taken off, loses nothing and is not counted.
 */

const res = (r: Record<string, unknown>) => ({ status: 'active', source: 'order', quantity: 10, invoicedQuantity: 0, dispatchedQuantity: 0, ...r })

describe('a supplier order’s cancel or complete', () => {
  const onOrdo = [
    res({ contactId: 'c1', internalOrderId: 'i1', quantity: 5 }),
    res({ contactId: 'c1', internalOrderId: 'i1', quantity: 3, dispatchedQuantity: 1 }),
    res({ contactId: 'c2', internalOrderId: 'i2', quantity: 4, invoicedQuantity: 1 }),
    res({ contactId: 'c3', quantity: 2 }), // reserved for a client directly, no client order
    res({ contactId: 'c4', internalOrderId: 'i3', quantity: 6, status: 'cancelled' }),
    res({ contactId: 'c5', internalOrderId: 'i4', quantity: 2, invoicedQuantity: 2, status: 'fulfilled' }),
  ]

  it('counts what is left of each live reservation', () => {
    const s = cascadeSummary(onOrdo, 'supplier', { i1: 'ORDI-2026-00002', i2: 'ORDI-2026-00001' })
    expect(s.count).toBe(4)
    expect(s.quantity).toBe(5 + 2 + 3 + 2)
    expect(s.clients).toBe(3)
    expect(s.withoutOrder).toBe(1)
  })

  it('names the client orders it lets down, in number order', () => {
    const s = cascadeSummary(onOrdo, 'supplier', { i1: 'ORDI-2026-00002', i2: 'ORDI-2026-00001', i3: 'ORDI-2026-00003' })
    expect(s.orders).toEqual([{ id: 'i2', number: 'ORDI-2026-00001' }, { id: 'i1', number: 'ORDI-2026-00002' }])
  })

  it('shows a client order it cannot name rather than dropping it', () => {
    expect(cascadeSummary([res({ internalOrderId: 'i9' })], 'supplier').orders).toEqual([{ id: 'i9', number: '…' }])
  })

  it('releases nothing when nothing is open', () => {
    expect(cascadeSummary(onOrdo.slice(4), 'supplier')).toEqual({ count: 0, quantity: 0, orders: [], clients: 0, withoutOrder: 0, fromStock: 0 })
    expect(cascadeSummary(undefined, 'supplier').count).toBe(0)
  })
})

describe('a client order’s cancel or complete', () => {
  const onOrdi = [
    res({ source: 'stock', quantity: 4 }),
    res({ source: 'order', orderId: 'o1', quantity: 3 }),
    res({ source: 'order', orderId: 'o1', quantity: 2, dispatchedQuantity: 2 }),
    res({ source: 'order', orderId: 'o2', quantity: 1 }),
  ]

  it('says how much sits on stock and which supplier orders get their room back', () => {
    const s = cascadeSummary(onOrdi, 'client', { o1: 'ORDO-2026-00007', o2: 'DRF-ORDO-2026-00001' })
    expect(s.count).toBe(3)
    expect(s.quantity).toBe(8)
    expect(s.fromStock).toBe(1)
    expect(s.withoutOrder).toBe(0)
    expect(s.orders.map((o) => o.number)).toEqual(['DRF-ORDO-2026-00001', 'ORDO-2026-00007'])
  })

  it('never names a stock reservation as an order', () => {
    expect(cascadeSummary([res({ source: 'stock', orderId: 'o1' })], 'client', { o1: 'ORDO-1' }).orders).toEqual([])
  })
})
