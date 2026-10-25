import { mongoose } from 'db/connection'
import { Order, Reservation, StockLevel, Warehouse, Contact, InternalOrder } from 'db/models'
import { ORDER_HOLDING_STATUSES, activeReservedForAllocation } from './reservation.service.js'

const { Types } = mongoose

/**
 * Where a product stands (#203): on the shelf, held for clients, on its way on outgoing orders,
 * and how much of what is on its way is already promised — the product's „Наличност" tab.
 *
 * Nothing is counted in two columns:
 *   - `reserved` is the StockLevel's own `reservedQuantity` — holds on stock that is here, which
 *     includes order-source reservations once their goods were received;
 *   - `reservedIncoming` is the part of an allocation's open reservations NOT yet held on stock
 *     (`activeReservedForAllocation` is exactly what the hold sync materialises), capped at what is
 *     still outstanding.
 *
 * Drafts are listed apart as `planned`: an outgoing order that was never sent brings nothing.
 */

const num = (v: any) => Number(v) || 0
const idStr = (v: any) => (v == null ? '' : String(v))
const nameOf = (c: any) => c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || ''

export interface SupplyWarehouseRow {
  warehouseId: string
  warehouseName: string
  onHand: number
  reserved: number
  available: number
  /** Ordered and not yet received, on sent / partly received outgoing orders. */
  incoming: number
  /** Of `incoming`, how much clients already have reserved. */
  reservedIncoming: number
  /** Outstanding on draft outgoing orders — not yet ordered. */
  planned: number
  /** The earliest expected date of what is incoming. */
  expectedDate: Date | null
}

export interface SupplyIncomingRow {
  orderId: string
  orderNumber: string
  status: string
  planned: boolean
  supplierId: string
  supplierName: string
  expectedDate: Date | null
  warehouseId: string
  warehouseName: string
  ordered: number
  received: number
  outstanding: number
  reservedIncoming: number
  clients: Array<{ contactId: string; name: string; quantity: number }>
}

export interface SupplyReservationRow {
  id: string
  number: string
  status: string
  source: 'stock' | 'order'
  contactId: string
  contactName: string
  warehouseId: string
  warehouseName: string
  orderId: string | null
  orderNumber: string | null
  internalOrderId: string | null
  internalOrderNumber: string | null
  quantity: number
  invoiced: number
  dispatched: number
  open: number
  expectedDate: Date | null
}

export interface ProductSupply {
  warehouses: SupplyWarehouseRow[]
  incoming: SupplyIncomingRow[]
  reservations: SupplyReservationRow[]
}

export async function getProductSupply(orgId: string, productId: string): Promise<ProductSupply> {
  const org = new Types.ObjectId(orgId)
  const product = new Types.ObjectId(productId)
  const [levels, orders, reservations] = await Promise.all([
    StockLevel.find({ orgId: org, productId: product } as any).lean().exec(),
    Order.find(
      { orgId: org, status: { $in: ['draft', ...ORDER_HOLDING_STATUSES] }, 'supplierGroups.lines.productId': product } as any,
      { orderNumber: 1, status: 1, expectedDate: 1, supplierGroups: 1 },
    ).sort({ expectedDate: 1, createdAt: 1 }).lean().exec(),
    Reservation.find({ orgId: org, productId: product, status: { $ne: 'cancelled' } } as any).sort({ createdAt: 1 }).lean().exec(),
  ])

  // Names, in one query per kind.
  const whIds = new Set<string>()
  const contactIds = new Set<string>()
  const ordiIds = new Set<string>()
  for (const l of levels as any[]) whIds.add(idStr(l.warehouseId))
  for (const o of orders as any[]) {
    for (const g of o.supplierGroups || []) {
      if (g.supplierId) contactIds.add(idStr(g.supplierId))
      for (const l of g.lines || []) for (const a of l.allocations || []) whIds.add(idStr(a.warehouseId))
    }
  }
  for (const r of reservations as any[]) {
    contactIds.add(idStr(r.contactId))
    whIds.add(idStr(r.warehouseId))
    if (r.internalOrderId) ordiIds.add(idStr(r.internalOrderId))
  }
  const [warehouses, contacts, ordis, otherOrders] = await Promise.all([
    whIds.size ? Warehouse.find({ orgId: org, _id: { $in: [...whIds].filter(Boolean) } } as any, { name: 1 }).lean().exec() : [],
    contactIds.size ? Contact.find({ orgId: org, _id: { $in: [...contactIds].filter(Boolean) } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : [],
    ordiIds.size ? InternalOrder.find({ orgId: org, _id: { $in: [...ordiIds] } } as any, { orderNumber: 1 }).lean().exec() : [],
    // Reservations can point at an order that no longer carries the product in an open state.
    Order.find(
      { orgId: org, _id: { $in: [...new Set((reservations as any[]).filter(r => r.orderId).map(r => idStr(r.orderId)))] } } as any,
      { orderNumber: 1, expectedDate: 1 },
    ).lean().exec(),
  ])
  const whName = new Map((warehouses as any[]).map(w => [idStr(w._id), w.name || '']))
  const contactName = new Map((contacts as any[]).map(c => [idStr(c._id), nameOf(c)]))
  const ordiNumber = new Map((ordis as any[]).map(o => [idStr(o._id), o.orderNumber || '']))
  const orderInfo = new Map<string, any>([...(otherOrders as any[]), ...(orders as any[])].map(o => [idStr(o._id), o]))

  const resByAlloc = new Map<string, any[]>()
  for (const r of reservations as any[]) {
    if (r.source !== 'order' || !r.allocationId) continue
    const k = idStr(r.allocationId)
    if (!resByAlloc.has(k)) resByAlloc.set(k, [])
    resByAlloc.get(k)!.push(r)
  }

  const incoming: SupplyIncomingRow[] = []
  for (const o of orders as any[]) {
    const holding = ORDER_HOLDING_STATUSES.includes(o.status)
    for (const g of o.supplierGroups || []) {
      for (const l of g.lines || []) {
        if (idStr(l.productId) !== productId) continue
        for (const a of l.allocations || []) {
          const ordered = num(a.quantity)
          const received = num(a.receivedQuantity)
          const outstanding = Math.max(0, ordered - received)
          const onAlloc = resByAlloc.get(idStr(a._id)) || []
          const open = onAlloc.reduce((s, r) => s + Math.max(0, num(r.quantity) - num(r.dispatchedQuantity)), 0)
          const held = holding ? activeReservedForAllocation(a, onAlloc) : 0
          const reservedIncoming = Math.min(outstanding, Math.max(0, open - held))
          if (outstanding <= 0 && reservedIncoming <= 0) continue
          const byClient = new Map<string, number>()
          for (const r of onAlloc) {
            const q = Math.max(0, num(r.quantity) - num(r.dispatchedQuantity))
            if (q > 0) byClient.set(idStr(r.contactId), (byClient.get(idStr(r.contactId)) || 0) + q)
          }
          incoming.push({
            orderId: idStr(o._id),
            orderNumber: o.orderNumber || '',
            status: o.status,
            planned: o.status === 'draft',
            supplierId: idStr(g.supplierId),
            supplierName: contactName.get(idStr(g.supplierId)) || '',
            expectedDate: o.expectedDate || null,
            warehouseId: idStr(a.warehouseId),
            warehouseName: whName.get(idStr(a.warehouseId)) || '',
            ordered,
            received,
            outstanding,
            reservedIncoming,
            clients: [...byClient.entries()].map(([contactId, quantity]) => ({ contactId, name: contactName.get(contactId) || '', quantity })),
          })
        }
      }
    }
  }

  const byWh = new Map<string, SupplyWarehouseRow>()
  const row = (warehouseId: string): SupplyWarehouseRow => {
    let w = byWh.get(warehouseId)
    if (!w) {
      w = { warehouseId, warehouseName: whName.get(warehouseId) || '', onHand: 0, reserved: 0, available: 0, incoming: 0, reservedIncoming: 0, planned: 0, expectedDate: null }
      byWh.set(warehouseId, w)
    }
    return w
  }
  for (const l of levels as any[]) {
    const w = row(idStr(l.warehouseId))
    w.onHand = num(l.quantity)
    w.reserved = num(l.reservedQuantity)
    w.available = l.availableQuantity !== undefined ? num(l.availableQuantity) : num(l.quantity) - num(l.reservedQuantity)
  }
  for (const i of incoming) {
    const w = row(i.warehouseId)
    if (i.planned) {
      w.planned += i.outstanding
      continue
    }
    w.incoming += i.outstanding
    w.reservedIncoming += i.reservedIncoming
    if (i.expectedDate && (!w.expectedDate || new Date(i.expectedDate) < new Date(w.expectedDate))) w.expectedDate = i.expectedDate
  }

  return {
    warehouses: [...byWh.values()].sort((a, b) => a.warehouseName.localeCompare(b.warehouseName)),
    incoming,
    reservations: (reservations as any[]).map(r => {
      const o = r.orderId ? orderInfo.get(idStr(r.orderId)) : null
      return {
        id: idStr(r._id),
        number: r.reservationNumber,
        status: r.status,
        source: r.source,
        contactId: idStr(r.contactId),
        contactName: contactName.get(idStr(r.contactId)) || '',
        warehouseId: idStr(r.warehouseId),
        warehouseName: whName.get(idStr(r.warehouseId)) || '',
        orderId: r.orderId ? idStr(r.orderId) : null,
        orderNumber: o?.orderNumber || null,
        internalOrderId: r.internalOrderId ? idStr(r.internalOrderId) : null,
        internalOrderNumber: r.internalOrderId ? ordiNumber.get(idStr(r.internalOrderId)) || null : null,
        quantity: num(r.quantity),
        invoiced: num(r.invoicedQuantity),
        dispatched: num(r.dispatchedQuantity),
        open: Math.max(0, num(r.quantity) - Math.max(num(r.invoicedQuantity), num(r.dispatchedQuantity))),
        expectedDate: r.expectedDate || o?.expectedDate || null,
      }
    }),
  }
}
