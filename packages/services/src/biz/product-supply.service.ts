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
 *
 * The reading is three steps over a SET of products — `loadSupplyDocs` → `incomingAllocations` →
 * `warehouseFigures` — then the names; a reader of several products shares the same definitions.
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

/** The documents the supply of a set of products is computed from. */
interface SupplyDocs {
  levels: any[]
  orders: any[]
  /** The products' live (not cancelled) reservations. */
  reservations: any[]
}

/** One allocation of a draft or open outgoing order that still brings one of the products. */
interface IncomingAllocation {
  productId: string
  order: any
  group: any
  warehouseId: string
  ordered: number
  received: number
  outstanding: number
  reservedIncoming: number
  /** The live reservations on the allocation. */
  reservations: any[]
}

type WarehouseFigures = Omit<SupplyWarehouseRow, 'warehouseId' | 'warehouseName'>

/** Three queries, whether for one product or a whole page of them. */
async function loadSupplyDocs(orgId: string, productIds: string[]): Promise<SupplyDocs> {
  const org = new Types.ObjectId(orgId)
  const products = productIds.map((id) => new Types.ObjectId(id))
  const [levels, orders, reservations] = await Promise.all([
    StockLevel.find({ orgId: org, productId: { $in: products } } as any).lean().exec(),
    Order.find(
      { orgId: org, status: { $in: ['draft', ...ORDER_HOLDING_STATUSES] }, 'supplierGroups.lines.productId': { $in: products } } as any,
      { orderNumber: 1, status: 1, expectedDate: 1, supplierGroups: 1 },
    ).sort({ expectedDate: 1, createdAt: 1 }).lean().exec(),
    Reservation.find({ orgId: org, productId: { $in: products }, status: { $ne: 'cancelled' } } as any).sort({ createdAt: 1 }).lean().exec(),
  ])
  return { levels, orders, reservations }
}

/**
 * What each allocation still brings: outstanding = ordered − received, and the part of its open
 * reservations that the shelf does not hold yet. In the orders' sequence (expected date first).
 */
function incomingAllocations(docs: SupplyDocs, products: ReadonlySet<string>): IncomingAllocation[] {
  const resByAlloc = new Map<string, any[]>()
  for (const r of docs.reservations) {
    if (r.source !== 'order' || !r.allocationId) continue
    const k = idStr(r.allocationId)
    if (!resByAlloc.has(k)) resByAlloc.set(k, [])
    resByAlloc.get(k)!.push(r)
  }

  const out: IncomingAllocation[] = []
  for (const o of docs.orders) {
    const holding = ORDER_HOLDING_STATUSES.includes(o.status)
    for (const g of o.supplierGroups || []) {
      for (const l of g.lines || []) {
        const productId = idStr(l.productId)
        if (!products.has(productId)) continue
        for (const a of l.allocations || []) {
          const ordered = num(a.quantity)
          const received = num(a.receivedQuantity)
          const outstanding = Math.max(0, ordered - received)
          const onAlloc = resByAlloc.get(idStr(a._id)) || []
          const open = onAlloc.reduce((s, r) => s + Math.max(0, num(r.quantity) - num(r.dispatchedQuantity)), 0)
          const held = holding ? activeReservedForAllocation(a, onAlloc) : 0
          const reservedIncoming = Math.min(outstanding, Math.max(0, open - held))
          if (outstanding <= 0 && reservedIncoming <= 0) continue
          out.push({ productId, order: o, group: g, warehouseId: idStr(a.warehouseId), ordered, received, outstanding, reservedIncoming, reservations: onAlloc })
        }
      }
    }
  }
  return out
}

/** Per product, per warehouse: the shelf and its holds from the stock levels, plus what is coming. */
function warehouseFigures(levels: any[], incoming: IncomingAllocation[]): Map<string, Map<string, WarehouseFigures>> {
  const byProduct = new Map<string, Map<string, WarehouseFigures>>()
  const row = (productId: string, warehouseId: string): WarehouseFigures => {
    let byWh = byProduct.get(productId)
    if (!byWh) byProduct.set(productId, (byWh = new Map()))
    let w = byWh.get(warehouseId)
    if (!w) {
      w = { onHand: 0, reserved: 0, available: 0, incoming: 0, reservedIncoming: 0, planned: 0, expectedDate: null }
      byWh.set(warehouseId, w)
    }
    return w
  }
  for (const l of levels) {
    const w = row(idStr(l.productId), idStr(l.warehouseId))
    w.onHand = num(l.quantity)
    w.reserved = num(l.reservedQuantity)
    w.available = l.availableQuantity !== undefined ? num(l.availableQuantity) : num(l.quantity) - num(l.reservedQuantity)
  }
  for (const i of incoming) {
    const w = row(i.productId, i.warehouseId)
    if (i.order.status === 'draft') {
      w.planned += i.outstanding
      continue
    }
    w.incoming += i.outstanding
    w.reservedIncoming += i.reservedIncoming
    const expected = i.order.expectedDate
    if (expected && (!w.expectedDate || new Date(expected) < new Date(w.expectedDate))) w.expectedDate = expected
  }
  return byProduct
}

export async function getProductSupply(orgId: string, productId: string): Promise<ProductSupply> {
  const id = String(new Types.ObjectId(productId))
  const docs = await loadSupplyDocs(orgId, [id])
  const { reservations } = docs
  const incoming = incomingAllocations(docs, new Set([id]))
  const figures = warehouseFigures(docs.levels, incoming).get(id) || new Map<string, WarehouseFigures>()

  // Names, in one query per kind.
  const org = new Types.ObjectId(orgId)
  const whIds = new Set<string>(figures.keys())
  const contactIds = new Set<string>()
  const ordiIds = new Set<string>()
  for (const i of incoming) if (i.group.supplierId) contactIds.add(idStr(i.group.supplierId))
  for (const r of reservations) {
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
      { orgId: org, _id: { $in: [...new Set(reservations.filter(r => r.orderId).map(r => idStr(r.orderId)))] } } as any,
      { orderNumber: 1, expectedDate: 1 },
    ).lean().exec(),
  ])
  const whName = new Map((warehouses as any[]).map(w => [idStr(w._id), w.name || '']))
  const contactName = new Map((contacts as any[]).map(c => [idStr(c._id), nameOf(c)]))
  const ordiNumber = new Map((ordis as any[]).map(o => [idStr(o._id), o.orderNumber || '']))
  const orderInfo = new Map<string, any>([...(otherOrders as any[]), ...docs.orders].map(o => [idStr(o._id), o]))

  return {
    warehouses: [...figures.entries()]
      .map(([warehouseId, w]) => ({ warehouseId, warehouseName: whName.get(warehouseId) || '', ...w }))
      .sort((a, b) => a.warehouseName.localeCompare(b.warehouseName)),
    incoming: incoming.map((i) => {
      const byClient = new Map<string, number>()
      for (const r of i.reservations) {
        const q = Math.max(0, num(r.quantity) - num(r.dispatchedQuantity))
        if (q > 0) byClient.set(idStr(r.contactId), (byClient.get(idStr(r.contactId)) || 0) + q)
      }
      return {
        orderId: idStr(i.order._id),
        orderNumber: i.order.orderNumber || '',
        status: i.order.status,
        planned: i.order.status === 'draft',
        supplierId: idStr(i.group.supplierId),
        supplierName: contactName.get(idStr(i.group.supplierId)) || '',
        expectedDate: i.order.expectedDate || null,
        warehouseId: i.warehouseId,
        warehouseName: whName.get(i.warehouseId) || '',
        ordered: i.ordered,
        received: i.received,
        outstanding: i.outstanding,
        reservedIncoming: i.reservedIncoming,
        clients: [...byClient.entries()].map(([contactId, quantity]) => ({ contactId, name: contactName.get(contactId) || '', quantity })),
      }
    }),
    reservations: reservations.map(r => {
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

