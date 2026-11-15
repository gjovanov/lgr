import { Contact, InternalOrder, Invoice, Org, Product, Reservation, Warehouse } from 'db/models'
import type { OrderSheetCtx } from 'reporting/order-sheet.i18n'

/**
 * What a supplier order's sheet is printed from, for every caller that prints one: the export route
 * (`GET /invoicing/orders/:id/export`) and the mail of ticked orders (`lib/doc-email.ts`). One builder, so the sheet a
 * supplier is mailed is the sheet the Export button downloads.
 *
 * Moved here from `order.controller.ts` as they were: `nameMaps` and `withoutExpectedPrices`.
 */

/**
 * FR-27.11.C.1 / C.4 (#529): an outgoing order's `expectedUnitPrice` is a purchase price, a cost figure. A role without
 * the costs reads no line's, and its save sets none: a new line's goes, an existing line's stays as stored.
 */
export function withoutExpectedPrices(order: any): any {
  const o = order?.toObject ? order.toObject() : order
  if (!o || !Array.isArray(o.supplierGroups)) return o
  return {
    ...o,
    supplierGroups: o.supplierGroups.map((g: any) => ({
      ...g,
      lines: Array.isArray(g?.lines) ? g.lines.map(({ expectedUnitPrice: _price, ...l }: any) => l) : g?.lines,
    })),
  }
}

// ── enrichment lookups ────────────────────────────────────────────────────────

export async function nameMaps(orgId: string, order: any, reservations: any[] = []) {
  const contactIds = new Set<string>()
  const warehouseIds = new Set<string>()
  const productIds = new Set<string>()
  const invoiceIds = new Set<string>()
  const internalOrderIds = new Set<string>()
  for (const g of order.supplierGroups || []) {
    if (g.supplierId) contactIds.add(String(g.supplierId))
    for (const line of g.lines || []) {
      if (line.productId) productIds.add(String(line.productId))
      for (const alloc of line.allocations || []) {
        if (alloc.warehouseId) warehouseIds.add(String(alloc.warehouseId))
      }
    }
  }
  for (const res of reservations) {
    if (res.contactId) contactIds.add(String(res.contactId))
    if (res.internalOrderId) internalOrderIds.add(String(res.internalOrderId))
    for (const iid of res.invoiceIds || []) invoiceIds.add(String(iid))
  }
  // A conversion invoice mixing sources may lack the doc-level orderId — match line refs too.
  const linkedInvoices = await Invoice.find(
    { orgId, $or: [{ orderId: order._id }, { 'lines.orderRef.orderId': order._id }] } as any,
    { invoiceNumber: 1, type: 1, direction: 1, status: 1, orderGroupId: 1, total: 1, currency: 1, issueDate: 1, contactId: 1 },
  ).lean().exec()
  for (const inv of linkedInvoices) invoiceIds.add(String((inv as any)._id))

  const [contacts, warehouses, products, internalOrders] = await Promise.all([
    contactIds.size ? Contact.find({ orgId, _id: { $in: [...contactIds] } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : [],
    warehouseIds.size ? Warehouse.find({ orgId, _id: { $in: [...warehouseIds] } } as any, { name: 1, code: 1 }).lean().exec() : [],
    productIds.size ? Product.find({ orgId, _id: { $in: [...productIds] } } as any, { name: 1, sku: 1, unit: 1 }).lean().exec() : [],
    internalOrderIds.size ? InternalOrder.find({ orgId, _id: { $in: [...internalOrderIds] } } as any, { orderNumber: 1, status: 1 }).lean().exec() : [],
  ])

  const contactName = (c: any) => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || String(c._id)
  return {
    contacts: Object.fromEntries(contacts.map((c: any) => [String(c._id), contactName(c)])),
    warehouses: Object.fromEntries(warehouses.map((w: any) => [String(w._id), w.name])),
    products: Object.fromEntries(products.map((p: any) => [String(p._id), { name: p.name, sku: p.sku, unit: p.unit }])),
    internalOrders: Object.fromEntries(internalOrders.map((o: any) => [String(o._id), { orderNumber: o.orderNumber, status: o.status }])),
    invoices: Object.fromEntries(linkedInvoices.map((i: any) => [String(i._id), {
      invoiceNumber: i.invoiceNumber, type: i.type, direction: i.direction, status: i.status,
      orderGroupId: i.orderGroupId ? String(i.orderGroupId) : undefined, total: i.total, currency: i.currency, issueDate: i.issueDate,
      contactId: i.contactId ? String(i.contactId) : undefined,
    }])),
  }
}

export type OrderSheetVariant = 'supplier' | 'internal'

/**
 * One supplier group's sheet: the supplier variant (an offer sheet, the internal data left out) or the internal one
 * (allocations and reservations).
 *
 * ⚠ `order` is the order AS THIS CALLER MAY READ IT: a role without the cost figures gets it through
 * `withoutExpectedPrices` first, and the sheet then carries no expected (purchase) price. The redaction is the
 * caller's, because the builder does not know who asks.
 */
export async function buildOrderSheetCtx(input: {
  orgId: string
  order: any
  /** One of `order.supplierGroups`. */
  group: any
  variant: OrderSheetVariant
  locale?: string
}): Promise<OrderSheetCtx> {
  const { orgId, order, group, variant } = input
  const resDocs = variant === 'internal'
    ? await Reservation.find({ orgId, orderId: order._id, status: { $ne: 'cancelled' } } as any).lean().exec()
    : []
  const [lookup, org, supplier] = await Promise.all([
    nameMaps(orgId, order, resDocs),
    Org.findById(orgId).lean().exec(),
    Contact.findOne({ _id: group.supplierId, orgId } as any).lean().exec(),
  ])
  const resByAlloc: Record<string, Array<{ contactId: any; quantity: number }>> = {}
  for (const r of resDocs) {
    const k = String((r as any).allocationId || '')
    if (!k) continue
    if (!resByAlloc[k]) resByAlloc[k] = []
    resByAlloc[k].push({ contactId: (r as any).contactId, quantity: (r as any).quantity })
  }

  return {
    order,
    group,
    org: {
      name: (org as any)?.name || 'Organization',
      taxNumber: (org as any)?.taxNumber,
      vatNumber: (org as any)?.vatNumber,
      email: (org as any)?.email,
      phone: (org as any)?.phone,
    },
    supplierName: lookup.contacts[String(group.supplierId)] || '',
    supplierTaxId: (supplier as any)?.taxNumber || (supplier as any)?.taxId,
    productInfo: lookup.products,
    warehouseNames: lookup.warehouses,
    contactNames: lookup.contacts,
    reservations: resByAlloc,
    locale: input.locale,
  }
}
